// Isolates the sample-playback gain: a single TapeDeviceBox unit plays one region of a KNOWN constant-amplitude
// mono sample (0.5) at unity region/volume, through BOTH the TS studio engine and the Rust/wasm engine, feeding
// the identical sample. The steady-state output amplitude should be 0.5 in both; a 2x discrepancy pinpoints a
// gain bug in the wasm audio-region player (`render_region`).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, AudioTimeStretchBox, AudioUnitBox, CaptureAudioBox, TapeDeviceBox, TrackBox, TransientMarkerBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const SAMPLE_AMPLITUDE = 0.5
const SAMPLE_FRAMES = 48000 // 1 s @ 48k
const CHANNELS = 2

// WHITE NOISE — fully DECORRELATED, so overlapping granular grains (read from different positions) that don't
// overlap-add to unity show up as an energy (RMS) loss. A sine stays correlated across nearby grains and hides it.
// Deterministic LCG (no Math.random, for stable tests).
const PCM_L = new Float32Array(SAMPLE_FRAMES)
const PCM_R = new Float32Array(SAMPLE_FRAMES)
let seed = 0x2545f491
const rnd = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 0xffffffff) * 2 - 1}
for (let i = 0; i < SAMPLE_FRAMES; i++) {
    PCM_L[i] = SAMPLE_AMPLITUDE * rnd()
    PCM_R[i] = SAMPLE_AMPLITUDE * rnd()
}
const PCM = [PCM_L, PCM_R]

const buildProject = (stretch: boolean) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let fileUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    unit.capture.refer(CaptureAudioBox.create(source, UUID.generate())) // the TS engine requires a capture
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(1.0)
        box.fileName.setValue("const")
    })
    fileUuid = UUID.toString(file.address.uuid)
    if (stretch) {
        // DENSE transients (~every 130 ms, like Ambition) so the granular sequencer crosses many boundaries.
        for (let t = 0; t < 1.0; t += 0.13) {
            TransientMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(file.transientMarkers); box.position.setValue(t)})
        }
    }
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const region = AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0)
        box.timeBase.setValue(TimeBase.Seconds)
        box.duration.setValue(1.0)
        box.loopDuration.setValue(0.25) // LOOP (like Ambition, loopDur < duration) in both native + stretch
        box.gain.setValue(0.0)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(collection.owners)
    })
    if (stretch) {
        const timeStretch = AudioTimeStretchBox.create(source, UUID.generate(), box => {
            box.transientPlayMode.setValue(TransientPlayMode.Pingpong) // Ambition's regions use Pingpong (mode 2)
            box.playbackRate.setValue(1.0) // NATIVE speed, like Ambition (warp is ~1:1)
        })
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(timeStretch.warpMarkers); box.position.setValue(0); box.seconds.setValue(0.0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(timeStretch.warpMarkers); box.position.setValue(3840); box.seconds.setValue(1.0)})
        region.playMode.refer(timeStretch)
    }
    source.endTransaction()
    return {source, fileUuid}
}

const sampleData = (): AudioData => {
    const data = AudioData.create(48000, SAMPLE_FRAMES, CHANNELS)
    for (let channel = 0; channel < CHANNELS; channel++) {data.frames[channel].set(PCM[channel])}
    return data
}

// Rust/wasm render feeding the sine sample; returns the steady-state RMS (middle of the render, one channel).
const renderWasmRms = async (source: ReturnType<typeof buildProject>["source"], quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const pointer = engine.sample_allocate(handle, SAMPLE_FRAMES * CHANNELS * 4)
        for (let channel = 0; channel < CHANNELS; channel++) {
            new Float32Array(memory.buffer, pointer + channel * SAMPLE_FRAMES * 4, SAMPLE_FRAMES).set(PCM[channel])
        }
        engine.sample_set_ready(handle, SAMPLE_FRAMES, CHANNELS, 48000)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 4 || q > quanta * 3 / 4) {continue} // steady-state middle only (avoid fades)
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; count++} // both channels (planar L|R)
    }
    return Math.sqrt(sum / count)
}

const measure = async (stretch: boolean, quanta: number): Promise<{ts: number, wasm: number, delta: number}> => {
    const {source, fileUuid} = buildProject(stretch)
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map<string, AudioData>([[fileUuid, sampleData()]]), quanta)
    // TS steady-state RMS: both channels, middle of the interleaved-planar buffer.
    let sum = 0, count = 0
    const stride = 128 * 2
    for (let q = Math.floor(quanta / 4); q < Math.floor(quanta * 3 / 4); q++) {
        for (let i = 0; i < stride; i++) {const v = ts.buffer[q * stride + i]; sum += v * v; count++}
    }
    const tsRms = Math.sqrt(sum / count)
    const wasm = await renderWasmRms(buildProject(stretch).source, quanta)
    return {ts: tsRms, wasm, delta: 20 * Math.log10(wasm / tsRms)}
}

describe("minimal tape level", () => {
    it("a unity-gain constant sample: native plays at the same level in TS and wasm", async () => {
        const native = await measure(false, 200)
        require("node:fs").writeFileSync("/tmp/tape-level.txt",
            `NATIVE  TS ${native.ts.toFixed(5)} WASM ${native.wasm.toFixed(5)} delta ${native.delta.toFixed(2)}dB\n`)
        expect(native.ts).toBeGreaterThan(0.1)
        expect(Math.abs(native.delta)).toBeLessThan(1.0) // native matches
    }, 120000)

    it("a TIME-STRETCHED unity sample: does the granular sequencer match TS?", async () => {
        const stretched = await measure(true, 200)
        require("node:fs").appendFileSync("/tmp/tape-level.txt",
            `STRETCH TS ${stretched.ts.toFixed(5)} WASM ${stretched.wasm.toFixed(5)} delta ${stretched.delta.toFixed(2)}dB\n`)
        expect(stretched.ts).toBeGreaterThan(0.1)
        expect(stretched.wasm).toBeGreaterThan(0.1)
    }, 120000)
})
