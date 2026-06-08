import {asDefined, isDefined, Option, panic, Procedure, Provider, unitValue} from "@opendaw/lib-std"
import {ExecutionProvider, ModelDescriptor, TaskDefinition} from "./Task"
import {SessionRun, TensorMap} from "./Tensor"
import {InferenceCancelledError} from "./Errors"
import {ModelStore} from "./ModelStore"
import {MainToWorker, WorkerCallId, WorkerToMain} from "./workers/protocol"

interface PendingCall {
    readonly id: WorkerCallId
    readonly resolve: (value: unknown) => void
    readonly reject: (reason: unknown) => void
}

interface QueueEntry {
    readonly run: () => Promise<void>
}

const NO_PROGRESS: Procedure<unitValue> = () => {}

export interface EngineHostOptions {
    readonly workerFactory: Provider<Worker>
}

export interface SessionNames {
    readonly inputs: ReadonlyArray<string>
    readonly outputs: ReadonlyArray<string>
}

export class EngineHost {
    readonly #workerFactory: Provider<Worker>
    readonly #pending = new Map<WorkerCallId, PendingCall>()
    readonly #loadedTasks = new Set<string>()
    readonly #names = new Map<string, SessionNames>()
    readonly #queue: Array<QueueEntry> = []

    #worker: Option<Worker> = Option.None
    #ready: Option<Promise<void>> = Option.None
    #nextCallId: WorkerCallId = 1
    #processing: boolean = false

    constructor(options: EngineHostOptions) {
        this.#workerFactory = options.workerFactory
    }

    async ensureLoaded(taskKey: string,
                       model: ModelDescriptor,
                       executionProviders: ReadonlyArray<ExecutionProvider>,
                       options?: {progress?: Procedure<unitValue>, signal?: AbortSignal}): Promise<void> {
        if (this.#loadedTasks.has(taskKey)) {
            options?.progress?.(1.0)
            return
        }
        const modelBytes = await ModelStore.ensure(taskKey, model, options)
        await this.#ensureWorker()
        this.#throwIfAborted(options?.signal)
        const ack = await this.#dispatch<Extract<WorkerToMain, {kind: "loaded"}>>({
            kind: "load",
            id: this.#nextId(),
            taskKey,
            model,
            modelBytes,
            executionProviders
        })
        this.#names.set(taskKey, {inputs: ack.inputs, outputs: ack.outputs})
        this.#loadedTasks.add(taskKey)
    }

    namesFor(taskKey: string): SessionNames {
        const names = this.#names.get(taskKey)
        if (isDefined(names)) {return names}
        return panic(`Session names not available for task: ${taskKey}`)
    }

    sessionRunFor(taskKey: string, signal: Option<AbortSignal>): SessionRun {
        return async (feeds: TensorMap): Promise<TensorMap> => {
            this.#throwIfAborted(signal.unwrapOrUndefined())
            const result = await this.#dispatch<Extract<WorkerToMain, {kind: "result"}>>({
                kind: "run",
                id: this.#nextId(),
                taskKey,
                feeds
            })
            return result.output
        }
    }

    enqueue<O>(work: (release: () => void) => Promise<O>): Promise<O> {
        return new Promise<O>((resolve, reject) => {
            const entry: QueueEntry = {
                run: async () => {
                    let released = false
                    const release = () => {released = true}
                    return work(release)
                        .then(value => resolve(value), reason => reject(reason))
                        .finally(() => {
                            if (!released) {
                                // entry completed without explicit release; that's fine
                            }
                        })
                }
            }
            this.#queue.push(entry)
            void this.#drain()
        })
    }

    async releaseTask(taskKey: string): Promise<void> {
        if (!this.#loadedTasks.has(taskKey)) {return}
        await this.#dispatch<Extract<WorkerToMain, {kind: "ok"}>>({kind: "release", id: this.#nextId(), taskKey})
        this.#loadedTasks.delete(taskKey)
        this.#names.delete(taskKey)
    }

    async shutdown(): Promise<void> {
        if (this.#worker.isEmpty()) {return}
        await this.#dispatch<Extract<WorkerToMain, {kind: "ok"}>>({kind: "shutdown", id: this.#nextId()})
        this.#worker.unwrap().terminate()
        this.#worker = Option.None
        this.#ready = Option.None
        this.#loadedTasks.clear()
        this.#pending.clear()
    }

    async #drain(): Promise<void> {
        if (this.#processing) {return}
        this.#processing = true
        while (this.#queue.length > 0) {
            const entry = asDefined(this.#queue.shift())
            await entry.run().catch(() => {})
        }
        this.#processing = false
    }

    #ensureWorker(): Promise<void> {
        if (this.#ready.nonEmpty()) {return this.#ready.unwrap()}
        const worker = this.#workerFactory()
        this.#worker = Option.wrap(worker)
        const promise = new Promise<void>((resolve, reject) => {
            const onMessage = (event: MessageEvent<WorkerToMain>): void => {
                const msg = event.data
                if (msg.kind === "ready") {
                    worker.removeEventListener("message", onMessage as EventListener)
                    worker.addEventListener("message", this.#onMessage as EventListener)
                    resolve()
                    return
                }
                if (msg.kind === "error") {
                    reject(new Error(`Worker initialization failed: ${msg.message}`))
                }
            }
            worker.addEventListener("message", onMessage as EventListener)
            worker.addEventListener("error", (event: ErrorEvent) =>
                reject(new Error(`Worker error: ${event.message}`)))
        })
        this.#ready = Option.wrap(promise)
        return promise
    }

    readonly #onMessage = (event: MessageEvent<WorkerToMain>): void => {
        const msg = event.data
        if (msg.kind === "ready") {return}
        const pending = this.#pending.get(msg.id)
        if (!isDefined(pending)) {return}
        this.#pending.delete(msg.id)
        if (msg.kind === "error") {pending.reject(new Error(msg.message)); return}
        if (msg.kind === "ok") {pending.resolve(msg); return}
        if (msg.kind === "loaded") {pending.resolve(msg); return}
        if (msg.kind === "result") {pending.resolve(msg); return}
    }

    async #dispatch<R extends WorkerToMain>(message: MainToWorker): Promise<R> {
        await this.#ensureWorker()
        const worker = this.#worker.unwrap("worker")
        return new Promise<R>((resolve, reject) => {
            this.#pending.set(message.id, {
                id: message.id,
                resolve: resolve as (value: unknown) => void,
                reject
            })
            worker.postMessage(message)
        })
    }

    #nextId(): WorkerCallId {
        const id = this.#nextCallId
        this.#nextCallId = this.#nextCallId + 1
        return id
    }

    #throwIfAborted(signal: AbortSignal | undefined): void {
        if (isDefined(signal) && signal.aborted) {
            throw new InferenceCancelledError()
        }
    }
}

export interface RunArgs<I, O> {
    readonly task: TaskDefinition<I, O>
    readonly input: I
    readonly progress: Procedure<unitValue>
    readonly signal: Option<AbortSignal>
    readonly executionProviders: ReadonlyArray<ExecutionProvider>
    /**
     * Fraction of the overall progress that the download / session-load phase
     * occupies. Defaults to 0.5 (download ↔ inference split). Pass 0 if the
     * caller has already preloaded the session (download is a guaranteed
     * cache hit) and the dialog should map 0..1 directly to inference.
     */
    readonly downloadShare?: number
}

export const splitProgress = (
    overall: Procedure<unitValue> | undefined,
    downloadShare: unitValue
): {download: Procedure<unitValue>, inference: Procedure<unitValue>} => {
    const handler = overall ?? NO_PROGRESS
    return {
        download:  (value: unitValue): void => handler(value * downloadShare),
        inference: (value: unitValue): void => handler(downloadShare + value * (1 - downloadShare))
    }
}

export const runTask = async <I, O>(host: EngineHost, args: RunArgs<I, O>): Promise<O> => {
    const overall = args.progress
    const share = args.downloadShare ?? 0.5
    const split = splitProgress(overall, share)
    await host.ensureLoaded(args.task.key, args.task.model, args.executionProviders, {
        progress: split.download,
        signal: args.signal.unwrapOrUndefined()
    })
    const session = host.sessionRunFor(args.task.key, args.signal)
    const names = host.namesFor(args.task.key)
    return args.task.run(args.input, {
        session,
        progress: split.inference,
        signal: args.signal,
        inputNames: names.inputs,
        outputNames: names.outputs
    })
}
