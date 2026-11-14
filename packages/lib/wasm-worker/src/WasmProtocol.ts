import {int, Procedure} from "@opendaw/lib-std"

export namespace WasmProtocol {
    export type Init = { readonly type: "init", readonly module: WebAssembly.Module }
    export type Call = {
        readonly type: "call"
        readonly id: int
        readonly method: string
        readonly input: ArrayBuffer
        readonly maxResultBytes: int
    }
    export type ToWorker = Init | Call

    export type Result = { readonly type: "result", readonly id: int, readonly output: ArrayBuffer }
    export type Failure = { readonly type: "failure", readonly id: int, readonly reason: string }
    // the module could not be instantiated, or the worker itself failed
    export type Broken = { readonly type: "broken", readonly reason: string }
    export type FromWorker = Result | Failure | Broken

    // what the worker side needs from its global scope or from a MessagePort
    export type Port = {
        post(message: FromWorker, transfer: Array<Transferable>): void
        listen(listener: Procedure<ToWorker>): void
    }

    // what the controller needs from a worker
    export type Endpoint = {
        send(message: ToWorker, transfer: Array<Transferable>): void
        terminate(): void
    }
    export type EndpointFactory = (receive: Procedure<FromWorker>) => Endpoint
}
