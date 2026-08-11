import {AudioData} from "@opendaw/lib-dsp"
import {stretchExports} from "./stretch-wasm"

export const detectBpm = async (audioData: AudioData, moduleUrl: string): Promise<number> => {
    const exports = await stretchExports(moduleUrl)
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
