import {Option, Procedure, unitValue} from "@opendaw/lib-std"
import {SessionRun} from "./Tensor"

export interface ModelDescriptor {
    readonly url: string
    readonly sha256: string
    readonly bytes: number
    readonly version: string
}

export type ExecutionProvider = "webgpu" | "wasm"

export const WASM_FALLBACK_PROVIDER: ExecutionProvider = "wasm"

export interface TaskEnvironment {
    readonly session: SessionRun
    readonly progress: Procedure<unitValue>
    readonly signal: Option<AbortSignal>
    readonly inputNames: ReadonlyArray<string>
    readonly outputNames: ReadonlyArray<string>
}

export interface TaskDefinition<I, O> {
    readonly key: string
    readonly model: ModelDescriptor
    readonly executionProviders: ReadonlyArray<ExecutionProvider>
    readonly run: (input: I, env: TaskEnvironment) => Promise<O>
}

export const defineTask = <I, O>(definition: TaskDefinition<I, O>): TaskDefinition<I, O> => definition
