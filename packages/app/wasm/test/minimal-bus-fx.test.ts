// Tests whether a device on a BUS (reconcile_bus fx chain) gets its parameters like on a normal unit. An
// instrument routes through a submix bus that carries a Compressor; if the wasm bus-fx params aren't delivered
// the compressor runs with default settings (over-compresses) -> the grouped-track quietness the user reports.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioBusBox, AudioUnitBox, CaptureMidiBox, CompressorDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

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

const build = (compressorOnBus: boolean) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const instrumentUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.index.setValue(1)
    })
    instrumentUnit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(instrumentUnit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    const bus = AudioBusBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses)
        box.output.refer(primaryAudioBusBox.input)
        box.label.setValue("Group")
    })
    const busUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.type.setValue("bus")
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(2)
    })
    bus.output.refer(busUnit.input)
    instrumentUnit.output.refer(bus.input) // instrument -> group bus
    if (compressorOnBus) {
        CompressorDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(busUnit.audioEffects) // the compressor lives on the GROUP
            box.index.setValue(0)
            box.threshold.setValue(-24.0)
            box.ratio.setValue(8.0)
            box.attack.setValue(5.0)
            box.release.setValue(100.0)
            box.automakeup.setValue(true)
        })
    }
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(instrumentUnit)
        box.tracks.refer(instrumentUnit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (const pitch of [60, 64, 67, 72]) {
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

const tsRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map(), quanta)
    let sum = 0, n = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const v = ts.buffer[q * 256 + i]; sum += v * v; n++}
    }
    return Math.sqrt(sum / n)
}

describe("minimal bus fx", () => {
    it("a compressor ON A BUS behaves the same in TS and wasm", async () => {
        const Q = 200
        const ts = await tsRms(build(true), Q)
        const wasm = await renderWasmRms(build(true), Q)
        require("node:fs").writeFileSync("/tmp/bus-fx.txt", `bus+compressor: TS rms ${ts.toExponential(4)} WASM rms ${wasm.toExponential(4)} delta ${(20 * Math.log10(wasm / ts)).toFixed(2)} dB\n`)
        expect(ts).toBeGreaterThan(0.01)
        expect(wasm).toBeGreaterThan(0.01)
    }, 60000)
})
