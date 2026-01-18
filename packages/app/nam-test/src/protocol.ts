/**
 * Protocol for communication between the main thread and NAM AudioWorklet processor.
 */
export interface NamProcessorProtocol {
    initWasm(wasmBinary: ArrayBuffer): Promise<void>
    loadModel(modelJson: string): Promise<boolean>
    setInputGain(value: number): void
    setOutputGain(value: number): void
    setMix(value: number): void
    setBypass(value: boolean): void
}
