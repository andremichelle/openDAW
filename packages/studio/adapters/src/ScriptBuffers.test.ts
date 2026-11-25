import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {AudioUnitBox, ScriptBufferBox, ScriptBufferChunkBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
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
        const bufferBox = asInstanceOf(device.buffers.pointerHub.filter()[0].box, ScriptBufferBox)
        const chunks = bufferBox.chunks.pointerHub.filter().map(({box}) => asInstanceOf(box, ScriptBufferChunkBox))
        expect(chunks.map(chunk => chunk.data.getValue().byteLength)).toEqual([8])
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
    it("splits long buffers into chunks and stores only the touched chunks on a write", async () => {
        const {device, compile, buffer, editing} = setup()
        const code = "// @buffer table 600"
        await compile(code)
        const table = buffer(code, "table")
        const chunks = () => asInstanceOf(device.buffers.pointerHub.filter()[0].box, ScriptBufferBox).chunks.pointerHub.filter()
            .map(({box}) => asInstanceOf(box, ScriptBufferChunkBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        expect(chunks().map(chunk => chunk.data.getValue().byteLength)).toEqual([1024, 1024, 352])
        const before = chunks().map(chunk => chunk.data.getValue())
        editing.modify(() => ScriptBuffers.write(device.buffers, table, 300, [0.5, 0.25]))
        const after = chunks().map(chunk => chunk.data.getValue())
        expect(after.map((bytes, index) => bytes === before[index])).toEqual([true, false, true])
        const values = ScriptBuffers.read(device.buffers, table)
        expect([values[299], values[300], values[301], values[302], values.length]).toEqual([0, 0.5, 0.25, 0, 600])
        editing.modify(() => ScriptBuffers.write(device.buffers, table, 254, [1, 2, 3, 4]))
        expect(Array.from(ScriptBuffers.read(device.buffers, table).subarray(254, 258))).toEqual([1, 2, 3, 4])
        await compile("// @buffer table 300")
        expect(chunks().map(chunk => chunk.data.getValue().byteLength)).toEqual([1024, 176])
        expect(Array.from(ScriptBuffers.read(device.buffers, buffer("// @buffer table 300", "table")).subarray(254, 258))).toEqual([1, 2, 3, 4])
    })
    describe("a buffer saved as one blob (before chunks)", () => {
        const legacySetup = async () => {
            const rig = setup()
            const code = "// @buffer table 300"
            await rig.compile(code)
            const bufferBox = asInstanceOf(rig.device.buffers.pointerHub.filter()[0].box, ScriptBufferBox)
            const legacy = Float32Array.from({length: 300}, (entry, index) => index / 300)
            rig.editing.modify(() => {
                bufferBox.chunks.pointerHub.filter().forEach(({box}) => box.delete())
                bufferBox.data.setValue(new Int8Array(legacy.buffer.slice(0)))
            })
            return {...rig, bufferBox, legacy, table: rig.buffer(code, "table"), code}
        }
        it("is read from the blob while there are no chunks", async () => {
            const {device, table, legacy} = await legacySetup()
            expect(Array.from(ScriptBuffers.read(device.buffers, table))).toEqual(Array.from(legacy))
        })
        it("moves into chunks on the first write and keeps every other value", async () => {
            const {device, table, legacy, bufferBox, editing} = await legacySetup()
            editing.modify(() => ScriptBuffers.write(device.buffers, table, 10, [7]))
            const values = ScriptBuffers.read(device.buffers, table)
            expect(values[10]).toBe(7)
            expect(values[9]).toBe(legacy[9])
            expect(values[299]).toBe(legacy[299])
            expect(bufferBox.data.getValue().byteLength).toBe(0)
            expect(bufferBox.chunks.pointerHub.size()).toBe(2)
        })
        it("moves into chunks on a compile", async () => {
            const {device, table, legacy, bufferBox, compile, code} = await legacySetup()
            await compile(code, "// @param gain 1")
            expect(bufferBox.data.getValue().byteLength).toBe(0)
            expect(Array.from(ScriptBuffers.read(device.buffers, table))).toEqual(Array.from(legacy))
        })
    })
})
