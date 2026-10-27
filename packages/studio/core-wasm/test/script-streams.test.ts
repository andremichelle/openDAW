// `@stream` telemetry for the scriptable devices: the bridge registers each declared stream on the worklet's
// broadcaster at the device address + [0x1000 + index], a value stream publishes the Float32Array the processor
// overwrites, a ring stream its latest samples in order, `.active` follows the subscription state, and a
// hot-swap re-registers (the old packages are terminated).
import {describe, expect, it} from "vitest"
import {Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import type {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {Address} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}

const STREAMING = `// @stream level 2
// @stream scope 8 ring
class Processor {
    counter = 0
    process({out}, {s0, s1}) {
        const [left, right] = out
        for (let i = s0; i < s1; i++) { left[i] = this.counter++ / 1000; right[i] = 0 }
        this.streams.level[0] = this.streams.level.active ? 1 : 0.5
        this.streams.level[1] = this.counter
        this.streams.scope.write(left, s0, s1)
    }
}`

type Package = {address: string, values: Float32Array, before?: (active: boolean) => void, terminated: boolean}

const recordingBroadcaster = () => {
    const packages: Array<Package> = []
    const broadcaster = {
        broadcastFloats: (address: Address, values: Float32Array, before?: (active: boolean) => void): Terminable => {
            const entry: Package = {address: address.toString(), values, before, terminated: false}
            packages.push(entry)
            return {terminate: () => {entry.terminated = true}}
        }
    } as unknown as LiveStreamBroadcaster
    return {packages, broadcaster}
}

const setup = async (code: string) => {
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
    source.endTransaction()
    const uuid = UUID.toString(device.address.uuid)
    new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 1, code))()
    const {packages, broadcaster} = recordingBroadcaster()
    const {engine, memory} = await loadFullEngine(48000, () => {}, () => broadcaster)
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const render = (quanta: number = 1) => {for (let quantum = 0; quantum < quanta; quantum++) {engine.render()}}
    return {device, uuid, packages, render}
}

describe("script @stream telemetry", () => {
    it("registers each stream at the device address + 0x1000 + index", async () => {
        const {device, packages, render} = await setup(STREAMING)
        render()
        expect(packages.map(({address, values}) => [address, values.length])).toEqual([
            [device.address.append(0x1000).toString(), 2],
            [device.address.append(0x1001).toString(), 8]
        ])
    })
    it("publishes a value stream as written and follows the subscription state", async () => {
        const {packages, render} = await setup(STREAMING)
        render()
        const [level] = packages
        expect(level.values[0]).toBe(0.5)
        level.before?.(true)
        render()
        expect(level.values[0]).toBe(1)
        expect(level.values[1]).toBeGreaterThan(0)
    })
    it("publishes the latest ring samples in order when subscribed", async () => {
        const {packages, render} = await setup(STREAMING)
        render(3)
        const [, scope] = packages
        scope.before?.(true)
        const values = Array.from(scope.values)
        const steps = values.slice(1).map((value, index) => Math.round((value - values[index]) * 1000))
        expect(steps).toEqual([1, 1, 1, 1, 1, 1, 1])
        expect(values[7]).toBeGreaterThan(0)
    })
    it("re-registers on a hot-swap and terminates the old packages", async () => {
        const {uuid, packages, render} = await setup(STREAMING)
        render()
        new Function(ScriptCompiler.wrap(WERKSTATT, uuid, 2, STREAMING.replace("// @stream scope 8 ring\n", "")))()
        render()
        expect(packages.map(({terminated}) => terminated)).toEqual([true, true, false])
    })
    it("registers nothing for a script without streams", async () => {
        const {packages, render} = await setup("class Processor { process({out}, {s0, s1}) { out[0].fill(0, s0, s1); out[1].fill(0, s0, s1) } }")
        render()
        expect(packages).toEqual([])
    })
})
