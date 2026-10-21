import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {AudioUnitBox, ScriptRecordBox, ScriptValueBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "./project/ProjectSkeleton"
import {ScriptCompiler} from "./ScriptCompiler"
import {ScriptDeclaration} from "./ScriptDeclaration"
import {ScriptRecords} from "./ScriptRecords"

const CONFIG: ScriptCompiler.Config = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const PROCESSOR = "class Processor { process() {} }"
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
    const compile = (...lines: ReadonlyArray<string>) => compiler.compile(context, editing, device, [...lines, PROCESSOR].join("\n"))
    const records = (collection: string) => device.records.pointerHub.filter()
        .map(({box}) => asInstanceOf(box, ScriptRecordBox))
        .filter(record => record.collection.getValue() === collection)
        .sort((left, right) => left.order.getValue() - right.order.getValue())
    const values = (collection: string) => records(collection).map(record => Object.fromEntries(record.values.pointerHub.filter()
        .map(({box}) => asInstanceOf(box, ScriptValueBox))
        .sort((left, right) => left.fieldIndex.getValue() - right.fieldIndex.getValue())
        .map(valueBox => [valueBox.field.getValue(), Number(valueBox.value.getValue().toFixed(4))])))
    const setValue = (collection: string, order: number, field: string, value: number) => editing.modify(() =>
        records(collection)[order].values.pointerHub.filter().map(({box}) => asInstanceOf(box, ScriptValueBox))
            .find(valueBox => valueBox.field.getValue() === field)?.value.setValue(value))
    return {editing, device, compile, records, values, setValue}
}

const STEPS = ["// @collection steps 3", "// @field steps.on true", "// @field steps.velocity 0.8 0 1 linear"]

describe("ScriptCompiler reconciles @collection records", () => {
    it("creates the declared records with their defaults", async () => {
        const {compile, values, records} = setup()
        await compile(...STEPS)
        expect(values("steps")).toEqual([{on: 1, velocity: 0.8}, {on: 1, velocity: 0.8}, {on: 1, velocity: 0.8}])
        expect(records("steps").map(record => [record.order.getValue(), record.collectionIndex.getValue()])).toEqual([[0, 0], [1, 0], [2, 0]])
    })
    it("creates seeded records", async () => {
        const {compile, values} = setup()
        await compile("// @collection partials", "// @field partials.level 0 0 1 linear",
            "// @record partials level=1", "// @record partials level=0.5")
        expect(values("partials")).toEqual([{level: 1}, {level: 0.5}])
    })
    it("grows and shrinks on a changed count and keeps the surviving values", async () => {
        const {compile, values, setValue} = setup()
        await compile(...STEPS)
        setValue("steps", 1, "velocity", 0.25)
        await compile("// @collection steps 5", ...STEPS.slice(1))
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.8, 0.25, 0.8, 0.8, 0.8])
        await compile("// @collection steps 2", ...STEPS.slice(1))
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.8, 0.25])
    })
    it("leaves a length changed in the view alone when the declaration is unchanged", async () => {
        const {compile, values, records, editing} = setup()
        await compile(...STEPS)
        editing.modify(() => records("steps")[2].delete())
        await compile(...STEPS, "// @param gain 1")
        expect(values("steps")).toHaveLength(2)
    })
    it("adds new fields with their default and removes dropped fields", async () => {
        const {compile, values} = setup()
        await compile(...STEPS)
        await compile(...STEPS.slice(0, 2), "// @field steps.gate 0.5 0.05 1 linear")
        expect(values("steps")[0]).toEqual({on: 1, gate: 0.5})
    })
    it("writes a changed seed only into untouched values", async () => {
        const {compile, values, setValue} = setup()
        await compile(...STEPS)
        setValue("steps", 0, "velocity", 0.3)
        await compile("// @collection steps 3", "// @field steps.on true", "// @field steps.velocity 0.6 0 1 linear")
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.3, 0.6, 0.6])
    })
    it("clamps values into a narrowed range", async () => {
        const {compile, values, setValue} = setup()
        await compile(...STEPS)
        setValue("steps", 0, "velocity", 0.9)
        await compile("// @collection steps 3", "// @field steps.on true", "// @field steps.velocity 0.5 0 0.7 linear")
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.7, 0.5, 0.5])
    })
    it("deletes the records of a removed collection, values included", async () => {
        const {compile, device} = setup()
        await compile(...STEPS)
        const graph = device.graph
        await compile("// @param gain 1")
        expect(device.records.pointerHub.size()).toBe(0)
        expect(graph.boxes().filter(box => box instanceof ScriptValueBox)).toHaveLength(0)
    })
    it("undoes a reshape with the code in one step", async () => {
        const {compile, values, editing} = setup()
        await compile(...STEPS)
        await compile("// @collection steps 1", ...STEPS.slice(1))
        expect(values("steps")).toHaveLength(1)
        editing.undo()
        expect(values("steps")).toHaveLength(3)
    })
    it("renumbers collection indices when collections are reordered", async () => {
        const {compile, records} = setup()
        await compile("// @collection a 1", "// @field a.x 0", "// @collection b 1", "// @field b.y 0")
        await compile("// @collection b 1", "// @field b.y 0", "// @collection a 1", "// @field a.x 0")
        expect(records("a")[0].collectionIndex.getValue()).toBe(1)
        expect(records("b")[0].collectionIndex.getValue()).toBe(0)
    })
})

describe("ScriptRecords edits and observation (the view side)", () => {
    const declared = () => ScriptDeclaration.parseCollections([...STEPS, "// @field steps.transpose 0 -12 12 int"].join("\n"))[0]
    const ready = async () => {
        const rig = setup()
        await rig.compile(...STEPS, "// @field steps.transpose 0 -12 12 int")
        return {...rig, collection: declared()}
    }
    it("reads the records in order with every field", async () => {
        const {device, collection} = await ready()
        expect(ScriptRecords.read(device.records, collection)).toEqual([
            {on: 1, velocity: expect.closeTo(0.8, 6), transpose: 0},
            {on: 1, velocity: expect.closeTo(0.8, 6), transpose: 0},
            {on: 1, velocity: expect.closeTo(0.8, 6), transpose: 0}
        ])
    })
    it("sets values clamped and rounded by their mapping, ignoring unknown fields and indices", async () => {
        const {device, collection, editing, values} = await ready()
        editing.modify(() => {
            ScriptRecords.set(device.records, collection, 1, {velocity: 2, transpose: 3.6, ghost: 1})
            ScriptRecords.set(device.records, collection, 9, {velocity: 0})
            ScriptRecords.set(device.records, collection, -1, {velocity: 0})
        })
        expect(values("steps")[1]).toEqual({on: 1, velocity: 1, transpose: 4})
        expect(values("steps")[0].velocity).toBeCloseTo(0.8, 4)
    })
    it("inserts with defaults for missing fields and renumbers the following records", async () => {
        const {device, collection, editing, values, records} = await ready()
        editing.modify(() => ScriptRecords.insert(device.records, collection, 1, {velocity: 0.1}))
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.8, 0.1, 0.8, 0.8])
        expect(records("steps").map(record => record.order.getValue())).toEqual([0, 1, 2, 3])
        editing.modify(() => ScriptRecords.insert(device.records, collection, 99, {}))
        expect(values("steps")).toHaveLength(5)
    })
    it("removes and renumbers, undo restores in one step", async () => {
        const {device, collection, editing, values, records} = await ready()
        editing.modify(() => ScriptRecords.set(device.records, collection, 1, {velocity: 0.5}))
        editing.modify(() => ScriptRecords.remove(device.records, collection, 0))
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.5, 0.8])
        expect(records("steps").map(record => record.order.getValue())).toEqual([0, 1])
        editing.undo()
        expect(values("steps").map(({velocity}) => velocity)).toEqual([0.8, 0.5, 0.8])
    })
    it("notifies once per transaction, also for values of records inserted later", async () => {
        const {device, collection, editing} = await ready()
        let calls = 0
        const subscription = ScriptRecords.observe(device.records, () => calls++)
        editing.modify(() => {
            ScriptRecords.set(device.records, collection, 0, {velocity: 0.1})
            ScriptRecords.set(device.records, collection, 1, {velocity: 0.2})
        })
        expect(calls).toBe(1)
        editing.modify(() => ScriptRecords.insert(device.records, collection, 0, {}))
        expect(calls).toBe(2)
        editing.modify(() => ScriptRecords.set(device.records, collection, 0, {velocity: 0.3}))
        expect(calls).toBe(3)
        editing.modify(() => device.label.setValue("Other"))
        expect(calls).toBe(3)
        subscription.terminate()
        editing.modify(() => ScriptRecords.set(device.records, collection, 0, {velocity: 0.4}))
        expect(calls).toBe(3)
    })
})
