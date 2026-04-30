import {MemoryBacking, MemoryPattern, MemoryThread} from "./MemoryBenchmark"

export type BenchmarkCategory = "Baseline" | "Audio Effect" | "Instrument" | "Memory"

export type BenchmarkResult = {
    readonly category: BenchmarkCategory
    readonly name: string
    readonly renderMs: number
    readonly marginalMs: number
    readonly perQuantumUs: number
    readonly durationSeconds: number
    readonly audio?: Float32Array[]
    readonly error?: string
    readonly memory?: {
        readonly backing: MemoryBacking
        readonly pattern: MemoryPattern
        readonly thread: MemoryThread
        readonly sizeMB: number
        readonly mbPerSec: number
        readonly nsPerOp: number
        readonly bestMs: number
        readonly medianMs: number
    }
}
