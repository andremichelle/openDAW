// `@collection` data for the scriptable devices: the record / value boxes under a device's `records` hub reach the
// user Processor as frozen `this.data.<collection>` arrays (engine snapshot -> `data_changed` -> script bridge),
// `dataChanged(name)` fires once after construction and after every real change, and a script without
// `@collection` never gets a `data` property.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, ScriptBufferBox, ScriptBufferChunkBox, ScriptRecordBox, ScriptValueBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
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
        if (!Object.isFrozen(this.data[name]) || !this.data[name].every(record => Object.isFrozen(record))) this.sum = -2
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
    const {engine, memory, scriptBridges} = await loadFullEngine(48000, (_uuid, message) => messages.push(message))
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
    return {source, device, records, render, edit, messages, scriptBridges}
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
    it("delivers an emptied collection as an empty array", async () => {
        const {records, render, edit} = await setup(SUMMING, [0.125, 0.25])
        render()
        await edit(() => records.forEach(({record}) => record.delete()))
        const {left, right} = render()
        expect(left).toBe(0)
        expect(right).toBeCloseTo(0.02, 6)
    })
    it("hands a @buffer to the Processor as a Float32Array next to the collections", async () => {
        const code = `// @buffer curve 3
class Processor {
    total = 0
    dataChanged(name) { if (name === "curve") this.total = this.data.curve.reduce((sum, value) => sum + value, 0) + (this.data.curve instanceof Float32Array ? 0 : 100) }
    process({out}, {s0, s1}) { for (let i = s0; i < s1; i++) { out[0][i] = this.total; out[1][i] = 0 } }
}`
        const {source, device, render, edit} = await setup(code, [])
        await edit(() => {
            const buffer = ScriptBufferBox.create(source, UUID.generate(), box => {
                box.owner.refer(device.buffers)
                box.label.setValue("curve")
                box.index.setValue(0)
            })
            ScriptBufferChunkBox.create(source, UUID.generate(), box => {
                box.owner.refer(buffer.chunks)
                box.index.setValue(0)
                box.data.setValue(new Int8Array(new Float32Array([0.25, 0.5, 0.125]).buffer))
            })
        })
        expect(render().left).toBeCloseTo(0.875, 6)
    })
    it("does not call dataChanged when nothing in the collection changed", async () => {
        const {device, render, edit} = await setup(SUMMING, [0.125])
        render()
        await edit(() => device.label.setValue("Renamed"))
        expect(render().right).toBeCloseTo(0.01, 6)
    })
    it("hands host.send messages to message() before the next process call, in order", async () => {
        const code = `class Processor {
    value = 0
    message(data) { this.value = this.value * 10 + data.digit }
    process({out}, {s0, s1}) { for (let i = s0; i < s1; i++) { out[0][i] = this.value; out[1][i] = 0 } }
}`
        const {device, render, scriptBridges, messages} = await setup(code, [])
        render()
        const uuid = UUID.toString(device.address.uuid)
        scriptBridges.message(uuid, {digit: 1})
        scriptBridges.message(uuid, {digit: 2})
        expect(render().left).toBe(12)
        scriptBridges.message(UUID.toString(UUID.generate()), {digit: 9})
        expect(render().left).toBe(12)
        expect(messages).toEqual([])
    })
    it("drops messages of a device that did not render this quantum", async () => {
        const code = `class Processor {
    value = 0
    message(data) { this.value += data.add }
    process({out}, {s0, s1}) { for (let i = s0; i < s1; i++) { out[0][i] = this.value; out[1][i] = 0 } }
}`
        const {device, render, scriptBridges} = await setup(code, [])
        render()
        scriptBridges.afterRender()
        const uuid = UUID.toString(device.address.uuid)
        scriptBridges.message(uuid, {add: 1})
        scriptBridges.afterRender()
        scriptBridges.message(uuid, {add: 2})
        expect(render().left).toBe(2)
        scriptBridges.afterRender()
        scriptBridges.message(uuid, {add: 4})
        expect(render().left).toBe(6)
    })
    it("silences a device whose message() throws", async () => {
        const code = `class Processor {
    message() { throw new Error("broken") }
    process({out}, {s0, s1}) { for (let i = s0; i < s1; i++) { out[0][i] = 1; out[1][i] = 1 } }
}`
        const {device, render, scriptBridges, messages} = await setup(code, [])
        expect(render().left).toBe(1)
        scriptBridges.message(UUID.toString(device.address.uuid), {})
        expect(render().left).toBe(0)
        expect(messages).toEqual([expect.stringContaining("Runtime error in message: Error: broken")])
    })
    it("leaves scripts without @collection without a data property", async () => {
        const {render, messages} = await setup(PLAIN, [])
        expect(render().left).toBe(1)
        expect(messages).toEqual([])
    })
})
