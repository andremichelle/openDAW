// Proves the Convolver's STEREO IR path end-to-end with a real recorded impulse response
// (test-files/impulse-reverb.wav: stereo, 44.1 kHz, 4 s — also exercising the load-time resample
// to the 48 kHz engine rate). The harness instrument is DUAL-MONO (identical L/R sine), so any
// channel difference in the wet output can only come from convolving each channel with its own
// IR side. A mono-duplicated IR is the control: its wet output must stay identical L/R.
import {readFileSync} from "node:fs"
import path from "node:path"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, allFinite, peakOf} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WAV_PATH = path.resolve(__dirname, "../../../../test-files/impulse-reverb.wav")

// minimal RIFF reader for the fixture: 16-bit PCM interleaved -> planar f32
const readWav = (): {left: Float32Array, right: Float32Array, sampleRate: number} => {
    const bytes = readFileSync(WAV_PATH)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 12
    let sampleRate = 0
    let channels = 0
    let bits = 0
    for (; ;) {
        const id = bytes.toString("ascii", offset, offset + 4)
        const size = view.getUint32(offset + 4, true)
        if (id === "fmt ") {
            channels = view.getUint16(offset + 10, true)
            sampleRate = view.getUint32(offset + 12, true)
            bits = view.getUint16(offset + 22, true)
        } else if (id === "data") {
            expect(channels).toBe(2)
            expect(bits).toBe(16)
            const frames = size / (channels * 2)
            const left = new Float32Array(frames)
            const right = new Float32Array(frames)
            for (let frame = 0; frame < frames; frame++) {
                left[frame] = view.getInt16(offset + 8 + frame * 4, true) / 32768
                right[frame] = view.getInt16(offset + 8 + frame * 4 + 2, true) / 32768
            }
            return {left, right, sampleRate}
        }
        offset += 8 + size + (size & 1)
    }
}

const convolver = (wet: number, dry: number): BoxGraph =>
    buildEffectProject(0.3, (source, unit) => {
        const file = AudioFileBox.create(source, UUID.generate(), fileBox => {
            fileBox.startInSeconds.setValue(0.0)
            fileBox.endInSeconds.setValue(4.0)
            fileBox.fileName.setValue("impulse-reverb.wav")
        })
        return ConvolverDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.wet.setValue(wet)
            box.dry.setValue(dry)
            box.normalize.setValue(true)
            box.file.refer(file)
        })
    })

// planar delivery: `channels` planes of `frames` f32 each, at the file's own sample rate
const render = async (source: BoxGraph, planes: ReadonlyArray<Float32Array>, sampleRate: number,
                      quanta = 128): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const frames = planes[0].length
        const pointer = engine.sample_allocate(handle, planes.length * frames * Float32Array.BYTES_PER_ELEMENT)
        planes.forEach((plane, channel) =>
            new Float32Array(memory.buffer, pointer + channel * frames * Float32Array.BYTES_PER_ELEMENT, frames).set(plane))
        engine.sample_set_ready(handle, frames, planes.length, sampleRate)
    }
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const out = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return out
}

// output is planar per quantum: L[128] then R[128]
const channelDifference = (interleaved: Float32Array, from: number): number => {
    const stride = 128 * 2
    const quanta = (interleaved.length / stride) | 0
    let max = 0
    for (let q = from; q < quanta; q++) {
        for (let i = 0; i < 128; i++) {
            max = Math.max(max, Math.abs(interleaved[q * stride + i] - interleaved[q * stride + 128 + i]))
        }
    }
    return max
}

describe("convolver stereo IR (test-files/impulse-reverb.wav)", () => {
    it("a stereo IR decorrelates a dual-mono source; a mono IR does not", async () => {
        const {left, right, sampleRate} = readWav()
        expect(sampleRate).toBe(44100)
        const settle = 32 // IR load is time-distributed; judge after it finished
        const stereo = await render(convolver(0.0, -100.0), [left, right], sampleRate)
        expect(allFinite(stereo)).toBe(true)
        const stereoPeak = peakOf(stereo)
        expect(stereoPeak).toBeGreaterThan(0.001)
        const stereoDiff = channelDifference(stereo, settle)
        const mono = await render(convolver(0.0, -100.0), [left], sampleRate)
        expect(allFinite(mono)).toBe(true)
        const monoDiff = channelDifference(mono, settle)
        console.info(`wet peak ${stereoPeak.toFixed(4)}, stereo L-R diff ${stereoDiff.toFixed(4)}, mono-IR L-R diff ${monoDiff.toExponential(2)}`)
        expect(stereoDiff).toBeGreaterThan(stereoPeak * 0.1) // each channel got its own IR side
        expect(monoDiff).toBeLessThan(1e-6) // duplicated IR keeps dual-mono exactly dual-mono
    }, 30000)

    it("the wet reverb audibly differs from the dry signal", async () => {
        const {left, right, sampleRate} = readWav()
        const dryOnly = await render(convolver(-100.0, 0.0), [left, right], sampleRate, 64)
        const wetted = await render(convolver(0.0, 0.0), [left, right], sampleRate, 64)
        expect(allFinite(wetted)).toBe(true)
        expect(peakOf(wetted)).toBeLessThan(2.0)
        let maxDiff = 0
        for (let i = 0; i < wetted.length; i++) {maxDiff = Math.max(maxDiff, Math.abs(wetted[i] - dryOnly[i]))}
        expect(maxDiff).toBeGreaterThan(0.001)
    }, 30000)
})
