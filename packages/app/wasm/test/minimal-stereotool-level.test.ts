// Chaotics' StereoTools have a big volume BOOST (+12 dB, +4.8 dB) with panningMixing=EqualPower. The bisect
// showed TS applies that boost but the wasm doesn't. This drives a sine through a StereoTool at +12 dB in both
// engines: the output levels must match.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, CrusherDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, StereoToolDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 0.2, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
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

const build = (volumeDb: number, panMix: number) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    CrusherDeviceBox.create(source, UUID.generate(), box => { // a benign first effect so StereoTool is 2nd in the chain
        box.host.refer(unit.audioEffects); box.index.setValue(0)
    })
    StereoToolDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects); box.index.setValue(1) // 2nd in the chain, like Chaotics
        box.volume.setValue(volumeDb)
        box.panningMixing.setValue(panMix)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
    return source
}

const wasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, n = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const o = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += o[i] * o[i]; n++}
    }
    return Math.sqrt(sum / n)
}

const tsRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map(), quanta)
    let sum = 0, n = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const v = ts.buffer[q * 256 + i]; sum += v * v; n++}
    }
    return Math.sqrt(sum / n)
}

describe("minimal stereotool level", () => {
    it("StereoTool +12 dB (EqualPower) applies the same boost in TS and wasm", async () => {
        const Q = 100
        const ts = await tsRms(build(12.0, 1), Q)
        const wasm = await wasmRms(build(12.0, 1), Q)
        require("node:fs").writeFileSync("/tmp/st-level.txt", `+12dB EqualPower: TS rms ${ts.toExponential(4)} WASM rms ${wasm.toExponential(4)} delta ${(20 * Math.log10(wasm / ts)).toFixed(2)} dB\n`)
        expect(ts).toBeGreaterThan(0.01)
        expect(wasm).toBeGreaterThan(0.01)
    }, 60000)
})
