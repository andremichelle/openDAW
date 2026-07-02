// Regression: a SIDECHAINED compressor on a submix BUS must duck off its sidechain SOURCE, not its own (hot) input.
// `reconcile_bus` built the bus fx chain but never created a SidechainBinding, and `resolve_sidechains` skipped
// `Wired::Bus` -> a ducking compressor on a synth bus detected on the summed synths themselves and crushed them
// (~10 dB), while the drums (which bypass the bus) stayed correct. Mirrors Chaotics: a synth routes through a bus
// whose compressor is sidechained to a TAPE drum (a DEVICE target, which both engines register). The wasm output
// must match the TS engine; without the fix the wasm crushes the synth and diverges by many dB.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData, TimeBase} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioBusBox, AudioFileBox, AudioRegionBox, AudioUnitBox, CaptureAudioBox, CaptureMidiBox, CompressorDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const FRAMES = 48000
const DRUM_AMP = 0.03 // BELOW the -20 dB threshold: a correct sidechain -> no ducking; detecting on the loud synth -> heavy ducking

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 0.8, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let fileUuid = ""
    let apparatUuid = ""
    source.beginTransaction()
    // The DRUM: a tape unit playing a loud constant sample, dry to master. Its TapeDeviceBox is the sidechain source.
    const drumUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        box.volume.setValue(-72.0) // inaudible in the mix: it exists ONLY as the sidechain source (tapped pre-strip)
    })
    const tape = TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(drumUnit.input))
    drumUnit.capture.refer(CaptureAudioBox.create(source, UUID.generate()))
    const drumTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(drumUnit); box.tracks.refer(drumUnit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("drum")
    })
    fileUuid = UUID.toString(file.address.uuid)
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.timeBase.setValue(TimeBase.Seconds); box.duration.setValue(1.0)
        box.loopDuration.setValue(1.0); box.gain.setValue(0.0)
        box.regions.refer(drumTrack.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    // The SYNTH bus + its ducking compressor, sidechained to the tape device.
    const bus = AudioBusBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses); box.output.refer(primaryAudioBusBox.input); box.label.setValue("Synth Bus")
    })
    const busUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.type.setValue("bus"); box.output.refer(primaryAudioBusBox.input); box.index.setValue(2)
    })
    bus.output.refer(busUnit.input)
    CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(busUnit.audioEffects); box.index.setValue(0)
        box.threshold.setValue(-20.0); box.ratio.setValue(6.0); box.attack.setValue(0.0); box.release.setValue(25.0)
        box.makeup.setValue(0.0); box.automakeup.setValue(false)
        box.sideChain.refer(tape) // sidechain -> the tape DEVICE (like Chaotics)
    })
    // The SYNTH: an Apparat sine routed through the bus.
    const synthUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(bus.input); box.index.setValue(3)
    })
    synthUnit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(synthUnit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    apparatUuid = UUID.toString(apparat.address.uuid)
    const synthTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(synthUnit); box.tracks.refer(synthUnit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000)
        box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(synthTrack.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, SYNTH))()
    return {source, fileUuid}
}

const drumSample = (): AudioData => {
    const data = AudioData.create(48000, FRAMES, 2)
    for (let channel = 0; channel < 2; channel++) {data.frames[channel].fill(DRUM_AMP)}
    return data
}

const wasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const pointer = engine.sample_allocate(handle, FRAMES * 2 * 4)
        for (let channel = 0; channel < 2; channel++) {
            new Float32Array(memory.buffer, pointer + channel * FRAMES * 4, FRAMES).fill(DRUM_AMP)
        }
        engine.sample_set_ready(handle, FRAMES, 2, 48000)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; count++}
    }
    return Math.sqrt(sum / count)
}

const tsRms = async (source: BoxGraph, fileUuid: string, quanta: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map<string, AudioData>([[fileUuid, drumSample()]]), quanta)
    let sum = 0, count = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const value = ts.buffer[q * 256 + i]; sum += value * value; count++}
    }
    return Math.sqrt(sum / count)
}

describe("bus sidechain compressor", () => {
    it("a sidechained compressor on a bus ducks off its source, not the bus signal (matches TS)", async () => {
        const Q = 200
        const withFx = build()
        const ts = await tsRms(withFx.source, withFx.fileUuid, Q)
        const wasm = await wasmRms(build().source, Q)
        expect(ts).toBeGreaterThan(0.01)
        expect(Math.abs(20 * Math.log10(wasm / ts))).toBeLessThan(0.5)
    }, 60000)
})
