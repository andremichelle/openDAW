// A scriptable device whose script fails must render SILENCE from then on. The bridge used to return without
// touching the output on a runtime error (and on every later call of the silenced device), and the engine keeps a
// device's output buffer between quanta, so the last rendered quantum looped forever.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const APPARAT = {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}

// Writes 0.25 for four calls, then writes 0.25 AND throws (a partial write before the error).
const failingEffect = `class Processor {
    calls = 0
    process({out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) { out[0][i] = 0.25; out[1][i] = 0.25 }
        if (++this.calls > 4) throw new Error("boom")
    }
}`
const failingInstrument = `class Processor {
    calls = 0
    process(output, {s0, s1}) {
        for (let i = s0; i < s1; i++) { output[0][i] = 0.25; output[1][i] = 0.25 }
        if (++this.calls > 4) throw new Error("boom")
    }
}`

const renderDevice = async (kind: "werkstatt" | "apparat") => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    if (kind === "werkstatt") {
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const device = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + failingEffect)
        })
        new Function(ScriptCompiler.wrap(WERKSTATT, UUID.toString(device.address.uuid), 1, failingEffect))()
    } else {
        const device = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + failingInstrument)
        })
        new Function(ScriptCompiler.wrap(APPARAT, UUID.toString(device.address.uuid), 1, failingInstrument))()
    }
    source.endTransaction()
    const messages: Array<string> = []
    const {engine, memory} = await loadFullEngine(48000, (_uuid, message) => messages.push(message))
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const len = engine.output_len() >>> 0
    const quanta: Array<Float32Array> = []
    for (let quantum = 0; quantum < 12; quantum++) {
        engine.render()
        quanta.push(new Float32Array(memory.buffer, engine.output_ptr(), len).slice())
    }
    return {quanta, messages}
}

describe("a failing script renders silence", () => {
    for (const kind of ["werkstatt", "apparat"] as const) {
        it(`${kind}: after a runtime error every quantum is silent, including the failing one`, async () => {
            const {quanta, messages} = await renderDevice(kind)
            expect(messages).toEqual(["Runtime error: Error: boom"])
            const firstFailing = quanta.findIndex(quantum => quantum.every(sample => sample === 0))
            expect(firstFailing).toBeGreaterThan(0) // it played before the error
            expect(quanta[0].some(sample => Math.abs(sample) > 0.1)).toBe(true)
            for (const quantum of quanta.slice(firstFailing)) {
                expect(quantum.every(sample => sample === 0)).toBe(true)
            }
        }, 30000)
    }
})
