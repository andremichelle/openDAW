import {AudioData, AudioMaterial, AudioMaterialFeatures, AudioMaterialSegment} from "@opendaw/lib-dsp"
import {stretchExports} from "./stretch-wasm"

// TransientDescriptor (crates/stretch/src/descriptor.rs, #[repr(C)], 64 bytes). Only the fields the
// classification reads are decoded; loop_start/loop_end (8, 16) and everything past rms belong to
// the stretch playback path.
const RECORD_SIZE = 64
const OFFSET_POSITION = 0
const OFFSET_STRENGTH = 24
const OFFSET_PERIOD = 28
const OFFSET_HARMONICITY = 32
const OFFSET_RMS = 36
const MAX_RECORDS = 16384

export const analyzeMaterial = async (audioData: AudioData, moduleUrl: string): Promise<AudioMaterialFeatures> => {
    const exports = await stretchExports(moduleUrl)
    if (exports.record_size() !== RECORD_SIZE) {
        return Promise.reject(new Error(`record_size mismatch: wasm=${exports.record_size()} js=${RECORD_SIZE}`))
    }
    const {numberOfFrames, numberOfChannels, sampleRate, frames} = audioData
    const durationSeconds = numberOfFrames / sampleRate
    const analyzerVersion = exports.analyzer_version()
    if (numberOfFrames === 0) {
        return AudioMaterial.aggregate([], 0.0, 0.0, analyzerVersion)
    }
    const bytes = numberOfFrames * 4
    const recordBytes = MAX_RECORDS * RECORD_SIZE
    // Allocate everything first: alloc grows linear memory (detaches views), so take views after.
    const leftPtr = exports.alloc_bytes(bytes)
    const rightPtr = exports.alloc_bytes(bytes)
    const outPtr = exports.alloc_bytes(recordBytes)
    new Float32Array(exports.memory.buffer, leftPtr, numberOfFrames).set(frames[0])
    new Float32Array(exports.memory.buffer, rightPtr, numberOfFrames).set(frames[numberOfChannels > 1 ? 1 : 0])
    // analyze() allocates internally too, so the result view must be taken from the buffer afterwards.
    const count = exports.analyze(leftPtr, rightPtr, numberOfFrames, sampleRate, outPtr, MAX_RECORDS)
    const view = new DataView(exports.memory.buffer)
    const segments: Array<AudioMaterialSegment> = []
    for (let index = 0; index < count; index++) {
        const base = outPtr + index * RECORD_SIZE
        segments.push({
            position: view.getFloat64(base + OFFSET_POSITION, true),
            strength: view.getFloat32(base + OFFSET_STRENGTH, true),
            period: view.getFloat32(base + OFFSET_PERIOD, true),
            harmonicity: view.getFloat32(base + OFFSET_HARMONICITY, true),
            rms: view.getFloat32(base + OFFSET_RMS, true)
        })
    }
    exports.free_bytes(leftPtr, bytes)
    exports.free_bytes(rightPtr, bytes)
    exports.free_bytes(outPtr, recordBytes)
    return AudioMaterial.aggregate(segments, durationSeconds, AudioMaterial.rmsOf(audioData), analyzerVersion)
}
