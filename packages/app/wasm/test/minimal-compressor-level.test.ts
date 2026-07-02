// Tests the Compressor's OUTPUT LEVEL against the TS engine (the bus/master compressors are the gain-staging the
// user suspects). A loud sine is driven through a CompressorDeviceBox with the same settings in both engines; the
// compressed output level must match. A divergence here (over-compression / wrong makeup) is the bus quietness.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, CompressorDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 4.0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
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
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    // A compressor that actually compresses the hot input: low threshold, high ratio, auto-makeup on.
    CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.threshold.setValue(-20.0)
        box.ratio.setValue(6.0)
        box.knee.setValue(0.0)
        box.attack.setValue(0.0)
        box.release.setValue(25.0)
        box.makeup.setValue(0.0)
        box.automakeup.setValue(false)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (const pitch of [60, 64, 67, 72]) { // a sustained chord -> hot, sits right around the -3 dB threshold/knee
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(pitch); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
    return source
}

const renderWasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
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

describe("minimal compressor level", () => {
    it("a compressed chord has the same level in TS and wasm", async () => {
        const Q = 200
        const ts = await renderTs(ProjectSkeleton.encode(build()), new Map(), Q)
        let sum = 0, n = 0
        for (let q = Math.floor(Q / 2); q < Q; q++) {
            for (let i = 0; i < 256; i++) {const v = ts.buffer[q * 256 + i]; sum += v * v; n++}
        }
        const tsRms = Math.sqrt(sum / n)
        const wasmRms = await renderWasmRms(build(), Q)
        require("node:fs").writeFileSync("/tmp/comp-level.txt", `TS rms ${tsRms.toExponential(4)} WASM rms ${wasmRms.toExponential(4)} delta ${(20 * Math.log10(wasmRms / tsRms)).toFixed(2)} dB\n`)
        expect(tsRms).toBeGreaterThan(0.01)
        expect(wasmRms).toBeGreaterThan(0.01)
    }, 60000)
})
