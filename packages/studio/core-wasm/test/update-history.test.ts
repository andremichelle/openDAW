import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {PrimitiveType, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {UpdateHistory} from "../src/sync/update-history"

type Task = UpdateTask<BoxIO.TypeMap>

describe("UpdateHistory", () => {
    const device = UUID.generate()
    const file = UUID.generate()
    const dump: Array<Task> = [
        {type: "new", name: "ConvolverDeviceBox", uuid: device, buffer: new ArrayBuffer(0)},
        {type: "new", name: "AudioFileBox", uuid: file, buffer: new ArrayBuffer(0)}
    ]

    it("summarises the dump and names boxes, fields and pointer targets without values", () => {
        const history = new UpdateHistory()
        history.record(dump)
        history.record([
            {type: "update-primitive", address: [device, new Int16Array([14])], primitiveType: PrimitiveType.Boolean, value: true},
            {type: "update-pointer", address: [device, new Int16Array([10])], target: [file, new Int16Array([])]},
            {type: "delete", uuid: device},
            {type: "delete", uuid: file}
        ])
        history.record([{type: "delete", uuid: device}])
        const entries = history.entries().map(entry => entry.replace(/ \d+\.\d+s /, " "))
        const [d, f] = [device, file].map(uuid => UUID.toString(uuid).slice(0, 8))
        expect(entries).toEqual([
            "#0 full dump of 2 ops",
            `#1 primitive ConvolverDeviceBox:${d}/14 (boolean)`,
            `#1 pointer ConvolverDeviceBox:${d}/10 -> AudioFileBox:${f}`,
            `#1 delete ConvolverDeviceBox:${d}`,
            `#1 delete AudioFileBox:${f}`,
            `#2 delete unknown box:${d}`
        ])
    })

    it("records sample loads with the requesting AudioFileBox", () => {
        const history = new UpdateHistory()
        history.record(dump)
        history.recordSample({type: "requested", uuid: file})
        history.recordSample({type: "delivered", uuid: file, numberOfFrames: 96000, numberOfChannels: 2, sampleRate: 48000})
        history.recordSample({type: "failed", uuid: device})
        const entries = history.entries().map(entry => entry.replace(/ \d+\.\d+s /, " "))
        const [d, f] = [device, file].map(uuid => UUID.toString(uuid).slice(0, 8))
        expect(entries.slice(1)).toEqual([
            `sample AudioFileBox:${f} requested`,
            `sample AudioFileBox:${f} delivered 96000 frames, 2 ch, 48000 Hz`,
            `sample ConvolverDeviceBox:${d} failed`
        ])
    })

    it("keeps only the last entries", () => {
        const history = new UpdateHistory()
        history.record(dump)
        for (let index = 0; index < UpdateHistory.CAPACITY + 10; index++) {
            history.record([{type: "update-primitive", address: [device, new Int16Array([11])], primitiveType: PrimitiveType.Float32, value: index}])
        }
        expect(history.entries().length).toBe(UpdateHistory.CAPACITY)
        expect(history.entries().at(-1)).toMatch(/^#42 /)
    })
})
