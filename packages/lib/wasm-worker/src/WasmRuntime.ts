import {int, Option, tryCatch} from "@opendaw/lib-std"
import {WasmProtocol} from "./WasmProtocol"

type Callable = (...values: Array<int>) => unknown
type Area = { pointer: int, capacity: int }

const isFunction = (value: unknown): value is Callable => typeof value === "function"

class Instance {
    readonly #memory: WebAssembly.Memory
    readonly #alloc: Callable
    readonly #exports: WebAssembly.Exports
    readonly #input: Area = {pointer: 0, capacity: 0}
    readonly #output: Area = {pointer: 0, capacity: 0}

    constructor(module: WebAssembly.Module) {
        const instance = new WebAssembly.Instance(module, {})
        const {memory, alloc} = instance.exports
        if (!(memory instanceof WebAssembly.Memory)) {throw new Error("the module exports no memory")}
        if (!isFunction(alloc)) {throw new Error("the module exports no alloc")}
        this.#memory = memory
        this.#alloc = alloc
        this.#exports = instance.exports
    }

    call(method: string, input: ArrayBuffer, maxResultBytes: int): ArrayBuffer {
        const target = this.#exports[method]
        if (method === "alloc" || !isFunction(target)) {throw new Error(`no method '${method}'`)}
        this.#reserve(this.#input, input.byteLength)
        this.#reserve(this.#output, maxResultBytes)
        new Uint8Array(this.#memory.buffer, this.#input.pointer, input.byteLength).set(new Uint8Array(input))
        const written = Number(target(this.#input.pointer, input.byteLength, this.#output.pointer, maxResultBytes))
        if (!Number.isInteger(written)) {throw new Error(`'${method}' returned ${written}`)}
        if (written < 0) {throw new Error(`'${method}' failed with ${written}`)}
        if (written > maxResultBytes) {throw new Error(`result of '${method}' larger than ${maxResultBytes} bytes`)}
        return this.#memory.buffer.slice(this.#output.pointer, this.#output.pointer + written)
    }

    #reserve(area: Area, length: int): void {
        if (length <= area.capacity) {return}
        const pointer = Number(this.#alloc(length))
        if (!Number.isInteger(pointer) || pointer <= 0 || pointer % 8 !== 0) {
            throw new Error(`alloc(${length}) returned ${pointer}, not an 8 byte aligned pointer`)
        }
        area.pointer = pointer
        area.capacity = length
    }
}

/** The worker side: instantiates the module it receives and runs one call per message. */
export class WasmRuntime {
    readonly #port: WasmProtocol.Port
    #module: Option<WebAssembly.Module> = Option.None
    #instance: Option<Instance> = Option.None

    constructor(port: WasmProtocol.Port) {
        this.#port = port
        port.listen(message => this.#receive(message))
    }

    #receive(message: WasmProtocol.ToWorker): void {
        if (message.type === "init") {
            this.#module = Option.wrap(message.module)
            this.#instantiate()
        } else {
            this.#call(message)
        }
    }

    #instantiate(): boolean {
        this.#instance = Option.None
        if (this.#module.isEmpty()) {return false}
        const module = this.#module.unwrap()
        const result = tryCatch(() => new Instance(module))
        if (result.status === "failure") {
            this.#port.post({type: "broken", reason: String(result.error)}, [])
            return false
        }
        this.#instance = Option.wrap(result.value)
        return true
    }

    #call({id, method, input, maxResultBytes}: WasmProtocol.Call): void {
        if (this.#instance.isEmpty() && !this.#instantiate()) {
            this.#port.post({type: "failure", id, reason: "the module is not instantiated"}, [])
            return
        }
        const instance = this.#instance.unwrap()
        const result = tryCatch(() => instance.call(method, input, maxResultBytes))
        if (result.status === "success") {
            this.#port.post({type: "result", id, output: result.value}, [result.value])
            return
        }
        // a trap can leave the instance's memory in any state, the next call starts on a fresh one
        if (result.error instanceof WebAssembly.RuntimeError) {this.#instance = Option.None}
        const reason = result.error instanceof Error ? result.error.message : String(result.error)
        this.#port.post({type: "failure", id, reason}, [])
    }
}
