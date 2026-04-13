export type BenchmarkCategory = "Baseline" | "Audio Effect" | "Instrument"

export type BenchmarkResult = {
    readonly category: BenchmarkCategory
    readonly name: string
    readonly renderMs: number
    readonly marginalMs: number
    readonly perQuantumUs: number
    readonly durationSeconds: number
    readonly audio?: Float32Array[]
    readonly error?: string
}
