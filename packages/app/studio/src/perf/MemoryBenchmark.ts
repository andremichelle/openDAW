export type MemoryPattern = "seq" | "random" | "interp"
export type MemoryBacking = "AB" | "SAB"
export type MemoryThread = "main" | "worker"

export type MemoryTest = {
    readonly id: string
    readonly label: string
    readonly backing: MemoryBacking
    readonly sizeMB: number
    readonly pattern: MemoryPattern
}

export type MemoryResult = {
    readonly id: string
    readonly label: string
    readonly backing: MemoryBacking
    readonly pattern: MemoryPattern
    readonly sizeMB: number
    readonly thread: MemoryThread
    readonly bestMs: number
    readonly medianMs: number
    readonly mbPerSec: number
    readonly nsPerOp: number
    readonly ops: number
}

export const MEMORY_TESTS: ReadonlyArray<MemoryTest> = [
    {id: "seq-1-ab",    label: "Seq read 1 MB AB",    backing: "AB",  sizeMB: 1,  pattern: "seq"},
    {id: "seq-1-sab",   label: "Seq read 1 MB SAB",   backing: "SAB", sizeMB: 1,  pattern: "seq"},
    {id: "seq-32-ab",   label: "Seq read 32 MB AB",   backing: "AB",  sizeMB: 32, pattern: "seq"},
    {id: "seq-32-sab",  label: "Seq read 32 MB SAB",  backing: "SAB", sizeMB: 32, pattern: "seq"},
    {id: "rnd-32-ab",   label: "Random 32 MB AB",     backing: "AB",  sizeMB: 32, pattern: "random"},
    {id: "rnd-32-sab",  label: "Random 32 MB SAB",    backing: "SAB", sizeMB: 32, pattern: "random"},
    {id: "ipl-32-ab",   label: "Interp 1.5x 32 MB AB",  backing: "AB",  sizeMB: 32, pattern: "interp"},
    {id: "ipl-32-sab",  label: "Interp 1.5x 32 MB SAB", backing: "SAB", sizeMB: 32, pattern: "interp"}
]

const WARMUP_RUNS = 5
const TIMED_RUNS = 7
const TARGET_BYTES_SEQ = 256 * 1024 * 1024
const TARGET_BYTES_INTERP = 128 * 1024 * 1024
const TARGET_BYTES_RANDOM = 16 * 1024 * 1024
const RANDOM_INDEX_COUNT = 1 << 20

let DCE_SINK = 0

const allocate = (backing: MemoryBacking, sizeBytes: number): Float32Array => {
    const buffer = backing === "SAB" ? new SharedArrayBuffer(sizeBytes) : new ArrayBuffer(sizeBytes)
    return new Float32Array(buffer)
}

const fillPattern = (arr: Float32Array): void => {
    const n = arr.length
    for (let i = 0; i < n; i++) {arr[i] = ((i * 0.000123) % 1.0) - 0.5}
}

const buildRandomIndices = (count: number, range: number): Uint32Array => {
    const out = new Uint32Array(count)
    for (let i = 0; i < count; i++) {out[i] = Math.floor(Math.random() * range)}
    return out
}

const seqRead = (arr: Float32Array, repeats: number): number => {
    let acc = 0
    const n = arr.length
    for (let r = 0; r < repeats; r++) {
        for (let i = 0; i < n; i++) {acc += arr[i]}
    }
    return acc
}

const randomRead = (arr: Float32Array, indices: Uint32Array, repeats: number): number => {
    let acc = 0
    const n = indices.length
    for (let r = 0; r < repeats; r++) {
        for (let i = 0; i < n; i++) {acc += arr[indices[i]]}
    }
    return acc
}

const interpRead = (arr: Float32Array, step: number, iters: number, repeats: number): number => {
    let acc = 0
    for (let r = 0; r < repeats; r++) {
        let pos = 0
        for (let i = 0; i < iters; i++) {
            const intIndex = pos | 0
            const frac = pos - intIndex
            acc += arr[intIndex] * (1 - frac) + arr[intIndex + 1] * frac
            pos += step
        }
    }
    return acc
}

const median = (sorted: ReadonlyArray<number>): number => sorted[(sorted.length - 1) >> 1]

export const runMemoryTest = (test: MemoryTest, thread: MemoryThread): MemoryResult => {
    const sizeBytes = test.sizeMB * 1024 * 1024
    const elements = sizeBytes >>> 2
    const arr = allocate(test.backing, sizeBytes)
    fillPattern(arr)
    let ops: number
    let kernel: () => number
    if (test.pattern === "seq") {
        const repeats = Math.max(1, Math.round(TARGET_BYTES_SEQ / sizeBytes))
        ops = elements * repeats
        kernel = () => seqRead(arr, repeats)
    } else if (test.pattern === "random") {
        const indices = buildRandomIndices(RANDOM_INDEX_COUNT, elements)
        const passes = Math.max(1, Math.round(TARGET_BYTES_RANDOM / (RANDOM_INDEX_COUNT * 4)))
        ops = RANDOM_INDEX_COUNT * passes
        kernel = () => randomRead(arr, indices, passes)
    } else {
        const step = 1.5
        const iters = Math.floor((elements - 1) / step)
        const repeats = Math.max(1, Math.round(TARGET_BYTES_INTERP / sizeBytes))
        ops = iters * repeats
        kernel = () => interpRead(arr, step, iters, repeats)
    }
    for (let w = 0; w < WARMUP_RUNS; w++) {DCE_SINK ^= kernel() | 0}
    const samples: Array<number> = []
    for (let r = 0; r < TIMED_RUNS; r++) {
        const start = performance.now()
        const value = kernel()
        const elapsed = performance.now() - start
        DCE_SINK ^= value | 0
        samples.push(elapsed)
    }
    samples.sort((a, b) => a - b)
    const bestMs = samples[0]
    const medianMs = median(samples)
    const bytes = ops * 4
    const mbPerSec = (bytes / 1024 / 1024) / (bestMs / 1000)
    const nsPerOp = (bestMs * 1_000_000) / ops
    return {id: test.id, label: test.label, backing: test.backing, pattern: test.pattern,
        sizeMB: test.sizeMB, thread, bestMs, medianMs, mbPerSec, nsPerOp, ops}
}

export const consumeSink = (): number => DCE_SINK
