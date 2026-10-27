// Reordering `@param` lines re-numbers the existing WerkstattParameterBox children (their declaration index). The
// engine must deliver every value under the NEW index, or the bridge maps it to the wrong label.
import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox, WerkstattParameterBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const BODY = `class Processor {
    alpha = -1
    beta = -1
    paramChanged(label, value) { this[label] = value }
    process({out}, {s0, s1}) { for (let i = s0; i < s1; i++) { out[0][i] = this.alpha; out[1][i] = this.beta } }
}`
const ORDER_A = `// @param alpha 0.25\n// @param beta 0.75\n${BODY}`
const ORDER_B = `// @param beta 0.75\n// @param alpha 0.25\n${BODY}`

describe("script params after a reorder", () => {
    it("keep their values under their labels", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const device = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + ORDER_A)
        })
        for (const [label, index, value] of [["alpha", 0, 0.25], ["beta", 1, 0.75]] as const) {
            WerkstattParameterBox.create(source, UUID.generate(), box => {
                box.owner.refer(device.parameters)
                box.label.setValue(label)
                box.index.setValue(index)
                box.value.setValue(value)
                box.defaultValue.setValue(value)
            })
        }
        source.endTransaction()
        const uuid = UUID.toString(device.address.uuid)
        new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 1, ORDER_A))()
        const {engine, memory} = await loadFullEngine(48000)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const len = engine.output_len() >>> 0
        const render = () => {
            for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
            const output = new Float32Array(memory.buffer, engine.output_ptr(), len).slice()
            return [output[len / 2 - 1], output[len - 1]]
        }
        expect(render()).toEqual([0.25, 0.75])
        // what a recompile with swapped @param lines does: new code, the existing boxes re-numbered in place
        source.beginTransaction()
        device.code.setValue("// @werkstatt js 1 2\n" + ORDER_B)
        for (const {box} of device.parameters.pointerHub.incoming()) {
            const param = asInstanceOf(box, WerkstattParameterBox)
            param.index.setValue(param.label.getValue() === "alpha" ? 1 : 0)
        }
        source.endTransaction()
        await sync.settle()
        new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 2, ORDER_B))()
        expect(render()).toEqual([0.25, 0.75])
    })
    it("keep a @sample file under its label", async () => {
        const body = `class Processor {
    process({out}, {s0, s1}) {
        const loaded = name => this.samples[name] !== null && this.samples[name] !== undefined ? 1 : 0
        for (let i = s0; i < s1; i++) { out[0][i] = loaded("kick"); out[1][i] = loaded("snare") }
    }
}`
        const orderA = `// @sample kick\n// @sample snare\n${body}`
        const orderB = `// @sample snare\n// @sample kick\n${body}`
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const device = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + orderA)
        })
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(1.0)
            box.fileName.setValue("synthetic")
        })
        for (const [label, index] of [["kick", 0], ["snare", 1]] as const) {
            WerkstattSampleBox.create(source, UUID.generate(), box => {
                box.owner.refer(device.samples)
                box.label.setValue(label)
                box.index.setValue(index)
                if (label === "kick") {box.file.refer(file)}
            })
        }
        source.endTransaction()
        const uuid = UUID.toString(device.address.uuid)
        new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 1, orderA))()
        const {engine, memory, drainSamples} = await loadFullEngine(48000)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const len = engine.output_len() >>> 0
        const render = () => {
            for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
            const output = new Float32Array(memory.buffer, engine.output_ptr(), len).slice()
            return [output[len / 2 - 1], output[len - 1]]
        }
        expect(render()).toEqual([1, 0])
        source.beginTransaction()
        device.code.setValue("// @werkstatt js 1 2\n" + orderB)
        for (const {box} of device.samples.pointerHub.incoming()) {
            const sample = asInstanceOf(box, WerkstattSampleBox)
            sample.index.setValue(sample.label.getValue() === "kick" ? 1 : 0)
        }
        source.endTransaction()
        await sync.settle()
        new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 2, orderB))()
        expect(render()).toEqual([1, 0])
    })
})
