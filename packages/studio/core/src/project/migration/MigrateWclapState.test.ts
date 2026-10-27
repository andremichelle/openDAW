import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox, WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {migrateWclapState} from "./MigrateWclapState"

const setup = (base64: string, bytes: ReadonlyArray<number> = []) => {
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    const device = WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(primaryAudioUnitBox.audioEffects)
        box.state.setValue(base64)
        box.pluginState.setValue(new Int8Array(bytes))
    })
    boxGraph.endTransaction()
    return {boxGraph, device}
}

const encode = (bytes: ReadonlyArray<number>): string => btoa(String.fromCharCode(...bytes))

describe("migrateWclapState", () => {
    it("moves the base64 state byte exact into plugin-state and clears the string", () => {
        const source = [0, 1, 127, 128, 255, 42]
        const {boxGraph, device} = setup(encode(source))
        migrateWclapState(boxGraph, device)
        expect(Array.from(new Uint8Array(device.pluginState.getValue().buffer))).toStrictEqual(source)
        expect(device.state.getValue()).toBe("")
    })

    it("moves a large state", () => {
        const source = Array.from({length: 1 << 20}, (_, index) => (index * 31) & 0xFF)
        const {boxGraph, device} = setup(Buffer.from(source).toString("base64"))
        migrateWclapState(boxGraph, device)
        const migrated = new Uint8Array(device.pluginState.getValue().buffer)
        expect(migrated.length).toBe(source.length)
        expect(migrated.every((value, index) => value === source[index])).toBe(true)
    })

    it("leaves an empty state alone", () => {
        const {boxGraph, device} = setup("")
        const before = device.pluginState.getValue()
        migrateWclapState(boxGraph, device)
        expect(device.pluginState.getValue()).toBe(before)
        expect(device.state.getValue()).toBe("")
    })

    it("keeps a string that is no valid base64", () => {
        const {boxGraph, device} = setup("not*base64!")
        migrateWclapState(boxGraph, device)
        expect(device.state.getValue()).toBe("not*base64!")
        expect(device.pluginState.getValue().length).toBe(0)
    })

    it("never overwrites an existing plugin-state", () => {
        const {boxGraph, device} = setup(encode([9, 9, 9]), [1, 2, 3])
        migrateWclapState(boxGraph, device)
        expect(Array.from(device.pluginState.getValue())).toStrictEqual([1, 2, 3])
        expect(device.state.getValue()).toBe(encode([9, 9, 9]))
    })

    it("running twice changes nothing", () => {
        const {boxGraph, device} = setup(encode([5, 6, 7]))
        migrateWclapState(boxGraph, device)
        const once = device.pluginState.getValue()
        migrateWclapState(boxGraph, device)
        expect(device.pluginState.getValue()).toBe(once)
        expect(Array.from(once)).toStrictEqual([5, 6, 7])
    })

    it("migrates an instrument", () => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({
            createDefaultUser: false, createOutputMaximizer: false
        })
        boxGraph.beginTransaction()
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
        })
        const device = WclapInstrumentBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.state.setValue(encode([200, 100]))
        })
        boxGraph.endTransaction()
        migrateWclapState(boxGraph, device)
        expect(Array.from(new Uint8Array(device.pluginState.getValue().buffer))).toStrictEqual([200, 100])
        expect(device.state.getValue()).toBe("")
    })
})
