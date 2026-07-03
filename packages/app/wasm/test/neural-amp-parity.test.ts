// TS-vs-WASM parity for the NeuralAmp device: the SAME `@opendaw/nam-wasm` core runs in both engines (the TS
// processor in-worklet, the wasm engine via the nam bridge), and the Rust wrapper mirrors the TS gain / mono /
// mix math, so a sine driven through the same WaveNet model must land at the same level in both. A divergence
// here means the bridge's model delivery, chunking, or wrapper arithmetic drifted from the TS processor.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NeuralAmpDeviceBox, NeuralAmpModelBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 0.5, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
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

const MODEL_JSON = readFileSync(path.resolve(__dirname, "assets", "wavenet.nam"), "utf8")

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
    const modelBox = NeuralAmpModelBox.create(source, UUID.generate(), model => {
        model.label.setValue("parity model")
        model.model.setValue(MODEL_JSON)
    })
    NeuralAmpDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.model.refer(modelBox)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(57); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
    return source
}

const renderWasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory, namBridges} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    await namBridges.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, count = 0
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        if (quantum < quanta / 2) {continue}
        const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += output[i] * output[i]; count++}
    }
    return Math.sqrt(sum / count)
}

describe("neural amp TS vs wasm parity", () => {
    it("the same WaveNet model lands at the same level in both engines", async () => {
        const QUANTA = 200
        const ts = await renderTs(ProjectSkeleton.encode(build()), new Map(), QUANTA)
        let sum = 0, count = 0
        for (let quantum = Math.floor(QUANTA / 2); quantum < QUANTA; quantum++) {
            for (let i = 0; i < 256; i++) {const value = ts.buffer[quantum * 256 + i]; sum += value * value; count++}
        }
        const tsRms = Math.sqrt(sum / count)
        const wasmRms = await renderWasmRms(build(), QUANTA)
        expect(tsRms).toBeGreaterThan(0.01)
        expect(wasmRms).toBeGreaterThan(0.01)
        const deltaDb = 20 * Math.log10(wasmRms / tsRms)
        expect(Math.abs(deltaDb)).toBeLessThan(0.05)
    }, 120000)
})
