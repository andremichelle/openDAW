// Regression: a sidechain pointer that targets a NON-TAPE device (here an Apparat synth) must tap that DEVICE's
// raw output, exactly like TS (where every device processor registers `adapter.address -> output`). The wasm
// engine only registered the tape instrument's raw output; any other device target fell back to the owning
// unit's STRIP output (post fx, post fader, post mute). With the source unit's fader at -72 dB the strip is
// silent, so the compressor never ducked in wasm while TS (tapping the raw, hot synth) ducked heavily — the
// engines diverged by many dB. Now every built device registers its output, so both engines tap the same signal.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, CompressorDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const synthCode = (gain: number) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * ${gain}
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const addNotes = (source: BoxGraph, unit: AudioUnitBox) => {
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000)
        box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
}

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    // The SIDECHAIN SOURCE: a hot Apparat sine on a unit whose fader is pulled to -72 dB. It is inaudible in the
    // mix; only the DEVICE's raw output is hot. TS taps that raw output — so must wasm.
    const sourceUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        box.volume.setValue(-72.0)
    })
    sourceUnit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const hotCode = synthCode(4.0)
    const sourceApparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(sourceUnit.input); box.code.setValue("// @apparat js 1 1\n" + hotCode)
    })
    addNotes(source, sourceUnit)
    // The PROGRAM: a moderate Apparat sine with a compressor sidechained to the SOURCE's DEVICE box. The hot
    // raw source (way above the -20 dB threshold) ducks the program hard.
    const programUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(2)
    })
    programUnit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const programCode = synthCode(0.5)
    const programApparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(programUnit.input); box.code.setValue("// @apparat js 1 1\n" + programCode)
    })
    CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(programUnit.audioEffects); box.index.setValue(0)
        box.threshold.setValue(-20.0); box.ratio.setValue(6.0); box.attack.setValue(0.0); box.release.setValue(25.0)
        box.makeup.setValue(0.0); box.automakeup.setValue(false); box.knee.setValue(0.0); box.mix.setValue(1.0)
        box.sideChain.refer(sourceApparat) // sidechain -> a NON-TAPE device
    })
    addNotes(source, programUnit)
    source.endTransaction()
    for (const [apparat, code] of [[sourceApparat, hotCode], [programApparat, programCode]] as const) {
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, code))()
    }
    return source
}

const wasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
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

const tsRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map(), quanta)
    let sum = 0, count = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const value = ts.buffer[q * 256 + i]; sum += value * value; count++}
    }
    return Math.sqrt(sum / count)
}

describe("sidechain device tap", () => {
    it("a compressor sidechained to a non-tape device taps the device's raw output (matches TS)", async () => {
        const Q = 200
        const ts = await tsRms(build(), Q)
        const wasm = await wasmRms(build(), Q)
        expect(ts).toBeGreaterThan(1e-4) // the ducked program still sounds
        expect(Math.abs(20 * Math.log10(wasm / ts))).toBeLessThan(0.5)
    }, 60000)
})
