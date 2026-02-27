export type ScriptExecutionContext = { sampleRate: number, baseFrequency: number }

export interface ScriptExecutionProtocol {
    executeScript(script: string, context: ScriptExecutionContext): Promise<void>
}