import {Nullable} from "@opendaw/lib-std"

export type ScriptExecutionContext = { sampleRate: number, baseFrequency: number }

export interface ScriptExecutionProtocol {
    executeScript(script: string, context: ScriptExecutionContext): Promise<void>
    evaluateScript(script: string, context: ScriptExecutionContext): Promise<Nullable<string>>
}