import {Option, Procedure, unitValue} from "@opendaw/lib-std"
import {SessionRun} from "./Tensor"

export interface ModelDescriptor {
    readonly url: string
    readonly sha256: string
    readonly bytes: number
    readonly version: string
}

export type ExecutionProvider = "webgpu" | "webnn-npu" | "webnn-gpu" | "wasm"

export interface TaskEnvironment<P = never> {
    readonly session: SessionRun
    readonly progress: Procedure<unitValue>
    readonly signal: Option<AbortSignal>
    readonly inputNames: ReadonlyArray<string>
    readonly outputNames: ReadonlyArray<string>
    readonly onPartial?: Procedure<P>
}

export interface TaskDefinition<I, O, P = never> {
    readonly key: string
    readonly model: ModelDescriptor
    readonly executionProviders: ReadonlyArray<ExecutionProvider>
    readonly run: (input: I, env: TaskEnvironment<P>) => Promise<O>
}

export const defineTask = <I, O, P = never>(definition: TaskDefinition<I, O, P>): TaskDefinition<I, O, P> => definition
