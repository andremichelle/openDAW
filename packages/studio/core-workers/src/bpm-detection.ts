import {AudioData} from "@opendaw/lib-dsp"

interface StretchExports {
    memory: WebAssembly.Memory
    alloc_bytes(len: number): number
    free_bytes(ptr: number, len: number): void
    detect_bpm(leftPtr: number, rightPtr: number, numFrames: number, sampleRate: number): number
}

// stretch_wasm: own-memory instance, empty imports, raw pointer/length ABI — the same module and the
// same contract the transient analysis uses.
const instances = new Map<string, Promise<StretchExports>>()

const instantiate = async (moduleUrl: string): Promise<StretchExports> => {
    const response = await fetch(moduleUrl)
    if (!response.ok) {
        return Promise.reject(new Error(`Could not load '${moduleUrl}' (${response.status} ${response.statusText})`))
    }
    const {instance} = await WebAssembly.instantiate(await response.arrayBuffer(), {})
    return instance.exports as unknown as StretchExports
}

export const detectBpm = async (audioData: AudioData, moduleUrl: string): Promise<number> => {
    const cached = instances.get(moduleUrl) ?? instantiate(moduleUrl)
    instances.set(moduleUrl, cached)
    const exports = await cached
    const {numberOfFrames, numberOfChannels, sampleRate, frames} = audioData
    if (numberOfFrames === 0) {return 0}
    const bytes = numberOfFrames * 4
    // Allocate both planes before taking any view: a growing memory detaches every existing view.
    const leftPtr = exports.alloc_bytes(bytes)
    const rightPtr = exports.alloc_bytes(bytes)
    new Float32Array(exports.memory.buffer, leftPtr, numberOfFrames).set(frames[0])
    new Float32Array(exports.memory.buffer, rightPtr, numberOfFrames).set(frames[numberOfChannels > 1 ? 1 : 0])
    const bpm = exports.detect_bpm(leftPtr, rightPtr, numberOfFrames, sampleRate)
    exports.free_bytes(leftPtr, bytes)
    exports.free_bytes(rightPtr, bytes)
    return bpm
}
