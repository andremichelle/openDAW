import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {AudioUnitBox, ScriptBufferBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "./project/ProjectSkeleton"
import {ScriptCompiler} from "./ScriptCompiler"
import {ScriptDeclaration} from "./ScriptDeclaration"
import {ScriptBuffers} from "./ScriptBuffers"

const CONFIG: ScriptCompiler.Config = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const context = {audioWorklet: {addModule: async () => {}}} as unknown as BaseAudioContext

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const editing = new BoxEditing(boxGraph)
    const device = editing.modify(() => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
        })
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        return WerkstattDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.audioEffects))
    }).unwrap("device")
    const compiler = ScriptCompiler.create(CONFIG)
    const compile = (...lines: ReadonlyArray<string>) =>
        compiler.compile(context, editing, device, [...lines, "class Processor { process() {} }"].join("\n"))
    const buffer = (code: string, name: string) => {
        const declaration = ScriptDeclaration.parseBuffers(code).find(candidate => candidate.name === name)
        if (declaration === undefined) {throw new Error(`no buffer ${name}`)}
        return declaration
    }
    return {editing, device, compile, buffer}
}

describe("ScriptDeclaration.parseBuffers", () => {
    it("parses buffers in order", () => {
        expect(ScriptDeclaration.parseBuffers("// @buffer wave 2048\n// @buffer curve 64 // a comment")).toEqual([
            {name: "wave", index: 0, length: 2048}, {name: "curve", index: 1, length: 64}
        ])
    })
    it("rejects malformed and clashing buffers", () => {
        expect(() => ScriptDeclaration.parseBuffers("// @buffer wave")).toThrow("Malformed @buffer")
        expect(() => ScriptDeclaration.parseBuffers("// @buffer wave 0")).toThrow("Malformed @buffer")
        expect(() => ScriptDeclaration.parseBuffers("// @buffer wave 4\n// @buffer wave 8")).toThrow("Duplicate data name 'wave'")
        expect(() => ScriptDeclaration.parseBuffers("// @collection wave\n// @buffer wave 8")).toThrow("Duplicate data name 'wave'")
        expect(() => ScriptDeclaration.parseBuffers("// @buffer __proto__ 8")).toThrow("Reserved name")
    })
})

describe("ScriptBuffers", () => {
    it("creates zeroed buffers on compile and deletes undeclared ones", async () => {
        const {device, compile, buffer} = setup()
        await compile("// @buffer wave 4", "// @buffer curve 2")
        expect(Array.from(ScriptBuffers.read(device.buffers, buffer("// @buffer wave 4", "wave")))).toEqual([0, 0, 0, 0])
        expect(device.buffers.pointerHub.size()).toBe(2)
        await compile("// @buffer wave 4")
        expect(device.buffers.pointerHub.size()).toBe(1)
    })
    it("writes a range, drops values outside, zeroes non-finite values, one undo step", async () => {
        const {device, compile, buffer, editing} = setup()
        await compile("// @buffer wave 4")
        const wave = buffer("// @buffer wave 4", "wave")
        editing.modify(() => ScriptBuffers.write(device.buffers, wave, 2, [0.5, Number.NaN, 9]))
        expect(Array.from(ScriptBuffers.read(device.buffers, wave))).toEqual([0, 0, 0.5, 0])
        editing.modify(() => ScriptBuffers.write(device.buffers, wave, -1, [7, 0.25]))
        expect(Array.from(ScriptBuffers.read(device.buffers, wave))).toEqual([0.25, 0, 0.5, 0])
        editing.undo()
        expect(Array.from(ScriptBuffers.read(device.buffers, wave))).toEqual([0, 0, 0.5, 0])
    })
    it("keeps the covered values when the length changes", async () => {
        const {device, compile, buffer, editing} = setup()
        await compile("// @buffer wave 4")
        editing.modify(() => ScriptBuffers.write(device.buffers, buffer("// @buffer wave 4", "wave"), 0, [1, 2, 3, 4]))
        await compile("// @buffer wave 6")
        expect(Array.from(ScriptBuffers.read(device.buffers, buffer("// @buffer wave 6", "wave")))).toEqual([1, 2, 3, 4, 0, 0])
        await compile("// @buffer wave 2")
        expect(Array.from(ScriptBuffers.read(device.buffers, buffer("// @buffer wave 2", "wave")))).toEqual([1, 2])
        const box = device.buffers.pointerHub.filter()[0].box
        expect(box instanceof ScriptBufferBox && box.data.getValue().byteLength).toBe(8)
    })
    it("notifies once per transaction that touched a buffer", async () => {
        const {device, compile, buffer, editing} = setup()
        await compile("// @buffer wave 4", "// @buffer curve 2")
        let calls = 0
        const subscription = ScriptBuffers.observe(device.buffers, () => calls++)
        editing.modify(() => {
            ScriptBuffers.write(device.buffers, buffer("// @buffer wave 4", "wave"), 0, [1])
            ScriptBuffers.write(device.buffers, buffer("// @buffer curve 2", "curve"), 0, [1])
        })
        expect(calls).toBe(1)
        editing.modify(() => device.label.setValue("Other"))
        expect(calls).toBe(1)
        subscription.terminate()
    })
})
