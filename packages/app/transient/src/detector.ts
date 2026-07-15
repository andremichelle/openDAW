import {assert} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

// One decoded TransientDescriptor record (crates/stretch/src/descriptor.rs, #[repr(C)], 64 bytes).
export interface Transient {
    position: number   // onset in SECONDS
    loopStart: number  // source SAMPLES (loopEnd <= loopStart => no loop)
    loopEnd: number
    strength: number   // [0,1] attack sharpness (~1 drum hit, ~0 pad swell)
    period: number     // fundamental period in SAMPLES, 0 = aperiodic
    harmonicity: number
    rms: number
}

const RECORD_SIZE = 64
const MAX_RECORDS = 16384

interface DetectorExports {
    memory: WebAssembly.Memory
    alloc_bytes(len: number): number
    free_bytes(ptr: number, len: number): void
    analyze(leftPtr: number, rightPtr: number, numFrames: number, sampleRate: number,
            outPtr: number, maxRecords: number): number
    record_size(): number
    analyzer_version(): number
}

// stretch-wasm: own-memory instance, empty imports, raw pointer/length ABI.
export class TransientDetector {
    static async load(url: string): Promise<TransientDetector> {
        const bytes = await fetch(url).then(response => response.arrayBuffer())
        const {instance} = await WebAssembly.instantiate(bytes, {})
        const exports = instance.exports as unknown as DetectorExports
        assert(exports.record_size() === RECORD_SIZE,
            `record_size mismatch: wasm=${exports.record_size()} js=${RECORD_SIZE}`)
        return new TransientDetector(exports)
    }

    readonly #exports: DetectorExports

    private constructor(exports: DetectorExports) {this.#exports = exports}

    get version(): number {return this.#exports.analyzer_version()}

    detect(audio: AudioData): ReadonlyArray<Transient> {
        const exports = this.#exports
        const frames = audio.numberOfFrames
        const left = audio.frames[0]
        const right = audio.frames[audio.numberOfChannels > 1 ? 1 : 0]
        // Allocate everything first: alloc grows linear memory (detaches views), so take views after.
        const leftPtr = exports.alloc_bytes(frames * 4)
        const rightPtr = exports.alloc_bytes(frames * 4)
        const outPtr = exports.alloc_bytes(MAX_RECORDS * RECORD_SIZE)
        new Float32Array(exports.memory.buffer, leftPtr, frames).set(left)
        new Float32Array(exports.memory.buffer, rightPtr, frames).set(right)
        // analyze() allocates internally too — re-fetch memory.buffer for the result read afterwards.
        const count = exports.analyze(leftPtr, rightPtr, frames, audio.sampleRate, outPtr, MAX_RECORDS)
        const view = new DataView(exports.memory.buffer)
        const result: Array<Transient> = []
        for (let index = 0; index < count; index++) {
            const base = outPtr + index * RECORD_SIZE
            result.push({
                position: view.getFloat64(base + 0, true),
                loopStart: view.getFloat64(base + 8, true),
                loopEnd: view.getFloat64(base + 16, true),
                strength: view.getFloat32(base + 24, true),
                period: view.getFloat32(base + 28, true),
                harmonicity: view.getFloat32(base + 32, true),
                rms: view.getFloat32(base + 36, true)
            })
        }
        exports.free_bytes(leftPtr, frames * 4)
        exports.free_bytes(rightPtr, frames * 4)
        exports.free_bytes(outPtr, MAX_RECORDS * RECORD_SIZE)
        return result
    }
}
