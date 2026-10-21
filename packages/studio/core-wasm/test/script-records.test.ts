// `@collection` data for the scriptable devices: the record / value boxes under a device's `records` hub reach the
// user Processor as frozen `this.data.<collection>` arrays (engine snapshot -> `data_changed` -> script bridge),
// `dataChanged(name)` fires once after construction and after every real change, and a script without
// `@collection` never gets a `data` property.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, ScriptRecordBox, ScriptValueBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}

// left = sum of `gains.value`, right = dataChanged count / 100
const SUMMING = `// @collection gains
// @field gains.value 0 0 1 linear
// @field gains.unused 0.5
class Processor {
    calls = 0
    sum = 0
    dataChanged(name) {
        this.calls++
        this.sum = this.data[name].reduce((total, record) => total + record.value, 0)
        if (this.data[name].some(record => record.unused !== 0.5)) this.sum = -1
        if (!Object.isFrozen(this.data[name]) || !Object.isFrozen(this.data[name][0] ?? {})) this.sum = -2
    }
    process({out}, {s0, s1}) {
        const [left, right] = out
        for (let i = s0; i < s1; i++) { left[i] = this.sum; right[i] = this.calls / 100 }
    }
}`

const PLAIN = `class Processor {
    process({out}, {s0, s1}) {
        const [left] = out
        for (let i = s0; i < s1; i++) left[i] = typeof this.data === "undefined" ? 1 : 0
    }
}`

const setup = async (code: string, values: ReadonlyArray<number>) => {
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
        box.code.setValue("// @werkstatt js 1 1\n" + code)
    })
    const records = values.map((value, order) => addRecord(source, device, order, value))
    source.endTransaction()
    new Function(ScriptCompiler.wrap(WERKSTATT, UUID.toString(device.address.uuid), 1, code))()
    const messages: Array<string> = []
    const {engine, memory} = await loadFullEngine(48000, (_uuid, message) => messages.push(message))
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const len = engine.output_len() >>> 0
    const render = () => {
        for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
        const output = new Float32Array(memory.buffer, engine.output_ptr(), len).slice()
        return {left: output[len / 2 - 1], right: output[len - 1]}
    }
    const edit = async (procedure: () => void) => {
        source.beginTransaction()
        procedure()
        source.endTransaction()
        await sync.settle()
    }
    return {source, device, records, render, edit, messages}
}

const addRecord = (source: BoxGraph, device: WerkstattDeviceBox, order: number, value: number) => {
    const record = ScriptRecordBox.create(source, UUID.generate(), box => {
        box.owner.refer(device.records)
        box.collection.setValue("gains")
        box.collectionIndex.setValue(0)
        box.order.setValue(order)
    })
    const valueBox = ScriptValueBox.create(source, UUID.generate(), box => {
        box.owner.refer(record.values)
        box.field.setValue("value")
        box.fieldIndex.setValue(0)
        box.value.setValue(value)
    })
    return {record, valueBox}
}

describe("script @collection data reaches the Processor", () => {
    it("delivers the records once after construction, filling missing fields with their default", async () => {
        const {render, messages} = await setup(SUMMING, [0.125, 0.25])
        const {left, right} = render()
        expect(messages).toEqual([])
        expect(left).toBeCloseTo(0.375, 6)
        expect(right).toBeCloseTo(0.01, 6)
    })
    it("follows a value edit, a record insert and a record delete", async () => {
        const {source, device, records, render, edit} = await setup(SUMMING, [0.125, 0.25])
        render()
        await edit(() => records[0].valueBox.value.setValue(0.5))
        expect(render()).toEqual({left: expect.closeTo(0.75, 6), right: expect.closeTo(0.02, 6)})
        await edit(() => addRecord(source, device, 2, 0.125))
        expect(render().left).toBeCloseTo(0.875, 6)
        await edit(() => records[1].record.delete())
        const {left, right} = render()
        expect(left).toBeCloseTo(0.625, 6)
        expect(right).toBeCloseTo(0.04, 6)
    })
    it("does not call dataChanged when nothing in the collection changed", async () => {
        const {device, render, edit} = await setup(SUMMING, [0.125])
        render()
        await edit(() => device.label.setValue("Renamed"))
        expect(render().right).toBeCloseTo(0.01, 6)
    })
    it("leaves scripts without @collection without a data property", async () => {
        const {render, messages} = await setup(PLAIN, [])
        expect(render().left).toBe(1)
        expect(messages).toEqual([])
    })
})
