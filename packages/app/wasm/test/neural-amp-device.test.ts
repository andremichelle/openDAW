// Wiring + behaviour: a NeuralAmp audio-effect in a real unit's fx chain must receive its model JSON off the
// box graph (`NeuralAmpModelBox` via `observe_target_string`), load it into the `@opendaw/nam-wasm` module
// through the nam bridge, and process the signal. A scriptable Apparat sine voices a note; with a model loaded
// and mix=1 the WaveNet output must differ from the dry sine — which only happens if the pointer observation,
// the JSON delivery, the lazy module load, and the per-chunk bridge copies all work. Without a model (and at
// mix=0) the device must pass the input through bit-exactly, the TS not-ready / dry paths.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NeuralAmpDeviceBox, NeuralAmpModelBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.5, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
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

const readModel = (file: string) => readFileSync(path.resolve(__dirname, "assets", file), "utf8")

const build = (modelJson: Nullable<string>, mix: number, mono: boolean = true) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let apparatUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    apparatUuid = UUID.toString(apparat.address.uuid)
    const modelBox = isDefined(modelJson)
        ? NeuralAmpModelBox.create(source, UUID.generate(), model => {
            model.label.setValue("test model")
            model.model.setValue(modelJson)
        })
        : null
    NeuralAmpDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.mono.setValue(mono)
        box.mix.setValue(mix)
        if (isDefined(modelBox)) {box.model.refer(modelBox)}
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
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.loopDuration.setValue(10_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, SYNTH))()
    return source
}

const render = async (source: ReturnType<typeof build>) => {
    const {engine, memory, namBridges} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    // The bind's catch-up delivered the model JSON, which kicked the LAZY nam module load; wait it out so the
    // wet path is live from the first quantum (the worklet would pass through until then, like the TS engine).
    await namBridges.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const half = len / 2
    const QUANTA = 32
    engine.stop(); engine.play()
    const left = new Float32Array(QUANTA * half)
    for (let q = 0; q < QUANTA; q++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), q * half)
    }
    return left
}

const peakOf = (buffer: Float32Array) => buffer.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
const diffRms = (a: Float32Array, b: Float32Array) => {
    let sum = 0
    for (let i = 0; i < a.length; i++) {sum += (a[i] - b[i]) ** 2}
    return Math.sqrt(sum / a.length)
}

describe("neural amp device", () => {
    it("shapes the instrument through a WaveNet model at full wet", async () => {
        const wet = await render(build(readModel("wavenet.nam"), 1.0))
        const dry = await render(build(readModel("wavenet.nam"), 0.0))
        expect(wet.every(sample => Number.isFinite(sample))).toBe(true)
        expect(peakOf(wet)).toBeGreaterThan(0.05)
        expect(peakOf(wet)).toBeLessThan(4.0)
        expect(diffRms(wet, dry)).toBeGreaterThan(0.01) // the amp model audibly reshapes the sine
    }, 60000)

    it("passes through bit-exactly without a model, matching the dry path", async () => {
        const unbound = await render(build(null, 1.0))
        const dry = await render(build(readModel("wavenet.nam"), 0.0))
        expect(unbound.length).toBe(dry.length)
        for (let i = 0; i < unbound.length; i++) {
            expect(unbound[i]).toBe(dry[i])
        }
    }, 60000)

    it("runs an LSTM model, and stereo mode, finite and audible", async () => {
        const lstm = await render(build(readModel("lstm.nam"), 1.0))
        expect(lstm.every(sample => Number.isFinite(sample))).toBe(true)
        expect(peakOf(lstm)).toBeGreaterThan(0.01)
        const stereo = await render(build(readModel("wavenet.nam"), 1.0, false))
        expect(stereo.every(sample => Number.isFinite(sample))).toBe(true)
        expect(peakOf(stereo)).toBeGreaterThan(0.05)
    }, 60000)
})
