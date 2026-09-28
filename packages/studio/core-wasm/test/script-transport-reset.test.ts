// Regression (#394): transport STOP must reach the scriptable audio + midi effects. A Werkstatt script that keeps
// state (a feedback delay) kept sounding after stop because the device exported no `reset`, and a Spielwerk
// script's documented `reset()` (TS: called on the discontinuous block) was never called.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const LEVEL = 0.5
const RESET_LEVEL = 0.25
const FLAG_TRANSPORTING = 1

// Stands in for a full-feedback delay: latches a level while transporting and holds it forever.
const LATCH = `class Processor {
    level = 0
    process({out}, {s0, s1, flags}) {
        if ((flags & ${FLAG_TRANSPORTING}) !== 0) { this.level = ${LEVEL} }
        const [l, r] = out
        for (let i = s0; i < s1; i++) { l[i] = this.level; r[i] = this.level }
    }
}`

// Same, but the script owns its reset: the bridge must call it instead of replacing the instance.
const LATCH_WITH_RESET = `class Processor {
    level = 0
    reset() { this.level = ${RESET_LEVEL} }
    process({out}, {s0, s1, flags}) {
        if ((flags & ${FLAG_TRANSPORTING}) !== 0) { this.level = ${LEVEL} }
        const [l, r] = out
        for (let i = s0; i < s1; i++) { l[i] = this.level; r[i] = this.level }
    }
}`

const renderPeak = (engine: any, memory: WebAssembly.Memory, quanta: number): number => {
    const len = engine.output_len() >>> 0
    let peak = 0
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        peak = 0 // only the LAST quantum counts, earlier ones may carry fades
        for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(out[i]))}
    }
    return peak
}

const setupWerkstatt = async (code: string) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const werkstatt = WerkstattDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.code.setValue("// @werkstatt js 1 1\n" + code)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
        UUID.toString(werkstatt.address.uuid), 1, code))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    return {engine, memory}
}

describe("script transport reset", () => {
    it("silences a stateful Werkstatt script without a reset() on transport stop", async () => {
        const {engine, memory} = await setupWerkstatt(LATCH)
        engine.stop(); engine.play()
        expect(renderPeak(engine, memory, 16), "the script sounds while playing").toBeCloseTo(LEVEL, 3)
        engine.stop()
        expect(renderPeak(engine, memory, 64), "the script state was dropped on stop").toBeLessThan(1e-4)
        engine.play()
        expect(renderPeak(engine, memory, 16), "the script still runs after the reset").toBeCloseTo(LEVEL, 3)
    }, 30000)

    it("calls a Werkstatt script's own reset() instead of replacing the instance", async () => {
        const {engine, memory} = await setupWerkstatt(LATCH_WITH_RESET)
        engine.stop(); engine.play()
        expect(renderPeak(engine, memory, 16)).toBeCloseTo(LEVEL, 3)
        engine.stop()
        expect(renderPeak(engine, memory, 64)).toBeCloseTo(RESET_LEVEL, 3)
    }, 30000)

    it("calls a Spielwerk script's reset() on a transport jump", async () => {
        const VOICE_LEVEL = 0.1
        const APPARAT = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    reset() { this.voices = [] }
    process(output, block) {
        const [l, r] = output
        const dc = this.voices.length * ${VOICE_LEVEL}
        for (let i = block.s0; i < block.s1; i++) { l[i] += dc; r[i] += dc }
    }
}`
        // Plays its note only once reset() has run, so the note is the proof of the call.
        const SPIELWERK = `class Processor {
    wasReset = false
    reset() { this.wasReset = true }
    * process(block, events) {
        if (this.wasReset && block.from <= 0 && 0 < block.to) {
            yield {position: 0, duration: 9600, pitch: 60, velocity: 1, cent: 0}
        }
    }
}`
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + APPARAT)
        })
        const spielwerk = SpielwerkDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.code.setValue("// @spielwerk js 1 1\n" + SPIELWERK)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, APPARAT))()
        new Function(ScriptCompiler.wrap({headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"},
            UUID.toString(spielwerk.address.uuid), 1, SPIELWERK))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        expect(renderPeak(engine, memory, 16), "the note gated on reset() sounds").toBeGreaterThan(VOICE_LEVEL / 2)
    }, 30000)
})
