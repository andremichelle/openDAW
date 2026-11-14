import {Arrays, Exec, int, isDefined, Option, Optional, Terminable, tryCatch} from "@opendaw/lib-std"
import {WasmProtocol} from "./WasmProtocol"

export namespace WasmWorker {
    /** How an aborted running call ends: `discard` drops its result (default), `restart` replaces the worker. */
    export type AbortMode = "discard" | "restart"
    export type CallOptions = {
        readonly maxResultBytes: int
        readonly signal?: AbortSignal
        readonly abort?: AbortMode
    }
    export type Construct = {
        readonly name: string
        readonly module: WebAssembly.Module
        readonly endpoint: WasmProtocol.EndpointFactory
    }

    /** The endpoint for the bundled worker (`@opendaw/lib-wasm-worker/worker.js`), its url comes from the host. */
    export const fromUrl = (workerUrl: string, name: string): WasmProtocol.EndpointFactory => receive => {
        const worker = new Worker(workerUrl, {type: "module", name})
        worker.onmessage = (event: MessageEvent<WasmProtocol.FromWorker>) => receive(event.data)
        worker.onerror = event => {
            event.preventDefault()
            receive({type: "broken", reason: event.message})
        }
        worker.onmessageerror = () => receive({type: "broken", reason: "a message from the worker could not be read"})
        return {
            send: (message, transfer) => worker.postMessage(message, transfer),
            terminate: () => worker.terminate()
        }
    }

    export const create = ({name, module, endpoint}: Construct): WasmWorker =>
        new WasmWorkerImpl(name, module, endpoint)
}

export interface WasmWorker extends Terminable {
    readonly name: string
    /** Runs `method` with `input` (the buffer is transferred) and resolves with the bytes it wrote. */
    call(method: string, input: ArrayBuffer, options: WasmWorker.CallOptions): Promise<ArrayBuffer>
}

type Job = {
    readonly id: int
    readonly method: string
    readonly input: ArrayBuffer
    readonly maxResultBytes: int
    readonly abort: WasmWorker.AbortMode
    readonly resolve: (output: ArrayBuffer) => void
    readonly reject: (reason: unknown) => void
    readonly release: Exec
    discarded: boolean
}

class WasmWorkerImpl implements WasmWorker {
    readonly name: string
    readonly #module: WebAssembly.Module
    readonly #factory: WasmProtocol.EndpointFactory
    readonly #queue: Array<Job> = []
    #endpoint: Option<WasmProtocol.Endpoint> = Option.None
    #running: Option<Job> = Option.None
    #ids: int = 0
    #generation: int = 0
    #terminated = false
    #answered = false
    #broken: Option<Error> = Option.None

    constructor(name: string, module: WebAssembly.Module, factory: WasmProtocol.EndpointFactory) {
        this.name = name
        this.#module = module
        this.#factory = factory
        this.#start()
    }

    call(method: string, input: ArrayBuffer,
         {maxResultBytes, signal, abort}: WasmWorker.CallOptions): Promise<ArrayBuffer> {
        if (this.#terminated) {return Promise.reject(new Error(`${this.name} is terminated`))}
        if (this.#broken.nonEmpty()) {return Promise.reject(this.#broken.unwrap())}
        if (isDefined(signal) && signal.aborted) {return Promise.reject(abortReason(signal))}
        const {promise, resolve, reject} = Promise.withResolvers<ArrayBuffer>()
        const onAbort = () => this.#abort(job, abortReason(signal))
        const job: Job = {
            id: ++this.#ids, method, input, maxResultBytes, abort: abort ?? "discard", resolve, reject,
            release: () => signal?.removeEventListener("abort", onAbort), discarded: false
        }
        signal?.addEventListener("abort", onAbort, {once: true})
        this.#queue.push(job)
        this.#next()
        return promise
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#endpoint.ifSome(endpoint => endpoint.terminate())
        this.#endpoint = Option.None
        const reason = new Error(`${this.name} is terminated`)
        this.#running.ifSome(job => this.#settle(job, reason))
        this.#running = Option.None
        const queued = [...this.#queue]
        Arrays.clear(this.#queue)
        queued.forEach(job => this.#settle(job, reason))
    }

    #start(): void {
        this.#answered = false
        const generation = ++this.#generation
        const endpoint = this.#factory(message => {if (generation === this.#generation) {this.#receive(message)}})
        endpoint.send({type: "init", module: this.#module}, [])
        this.#endpoint = Option.wrap(endpoint)
    }

    #restart(): void {
        this.#endpoint.ifSome(endpoint => endpoint.terminate())
        this.#start()
    }

    #next(): void {
        if (this.#terminated || this.#broken.nonEmpty() || this.#running.nonEmpty()) {return}
        const job: Optional<Job> = this.#queue.shift()
        if (!isDefined(job)) {return}
        const {id, method, input, maxResultBytes} = job
        const endpoint = this.#endpoint.unwrap()
        const sent = tryCatch(() => endpoint.send({type: "call", id, method, input, maxResultBytes}, [input]))
        if (sent.status === "failure") {
            this.#settle(job, sent.error)
            this.#next()
            return
        }
        this.#running = Option.wrap(job)
    }

    #receive(message: WasmProtocol.FromWorker): void {
        if (this.#terminated) {return}
        if (message.type === "broken") {
            const reason = new Error(`${this.name}: ${message.reason}`)
            this.#running.ifSome(job => this.#settle(job, reason))
            this.#running = Option.None
            if (this.#answered) {
                this.#restart()
                this.#next()
            } else {
                this.#broken = Option.wrap(reason)
                this.#endpoint.ifSome(endpoint => endpoint.terminate())
                this.#endpoint = Option.None
                const queued = [...this.#queue]
                Arrays.clear(this.#queue)
                queued.forEach(job => this.#settle(job, reason))
            }
            return
        }
        this.#answered = true
        if (this.#running.isEmpty() || this.#running.unwrap().id !== message.id) {return}
        const job = this.#running.unwrap()
        this.#running = Option.None
        if (message.type === "result") {
            this.#settle(job, message.output)
        } else {
            this.#settle(job, new Error(`${this.name}.${job.method}: ${message.reason}`))
        }
        this.#next()
    }

    #abort(job: Job, reason: unknown): void {
        const index = this.#queue.indexOf(job)
        if (index !== -1) {
            this.#queue.splice(index, 1)
            this.#settle(job, reason)
            return
        }
        if (this.#running.isEmpty() || this.#running.unwrap() !== job) {return}
        if (job.abort === "restart") {
            this.#running = Option.None
            this.#settle(job, reason)
            this.#restart()
            this.#next()
        } else {
            this.#settle(job, reason)
        }
    }

    #settle(job: Job, outcome: ArrayBuffer | unknown): void {
        if (job.discarded) {return}
        job.discarded = true
        job.release()
        if (outcome instanceof ArrayBuffer) {job.resolve(outcome)} else {job.reject(outcome)}
    }
}

const abortReason = (signal: Optional<AbortSignal>): unknown =>
    isDefined(signal) && isDefined(signal.reason) ? signal.reason : new DOMException("Aborted", "AbortError")
