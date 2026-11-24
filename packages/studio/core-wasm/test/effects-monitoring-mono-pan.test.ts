// #575: a mono source is routed onto two channels with the same signal (MonitoringRouter), so the strip's stereo
// output returns on both. Panned hard right, the right channel carries it and the left is silent. The pair sits
// on the top channels, which only exist with sixteen monitoring channels.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SILENT = `class Processor { process(output, block) {} }`
const QUANTUM = 128
const CHANNELS = 16
const LEFT = 14
const RIGHT = 15

describe("effects monitoring of a mono source", () => {
    it("returns both strip channels, so a hard right pan keeps the signal", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SILENT)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, SILENT))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const pointer = engine.input_reserve(24)
        new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
        const view = new DataView(memory.buffer, pointer, 24)
        view.setInt32(16, LEFT, true)
        view.setInt32(20, RIGHT, true)
        engine.set_monitoring_map(1)
        const render = (): [number, number] => {
            const staging = new Float32Array(memory.buffer, engine.monitor_input_ptr(), CHANNELS * QUANTUM)
            staging.fill(0.0)
            staging.fill(0.5, LEFT * QUANTUM, (RIGHT + 1) * QUANTUM)
            engine.render()
            const staged = new Float32Array(memory.buffer, engine.monitor_output_ptr(), CHANNELS * QUANTUM)
            const peak = (channel: number) => staged.subarray(channel * QUANTUM, (channel + 1) * QUANTUM)
                .reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
            return [peak(LEFT), peak(RIGHT)]
        }
        for (let warm = 0; warm < 8; warm++) {render()}
        const [centreLeft, centreRight] = render()
        expect(centreLeft).toBeGreaterThan(0.4)
        expect(centreRight).toBeGreaterThan(0.4)
        source.beginTransaction()
        unit.panning.setValue(1.0)
        source.endTransaction()
        await sync.settle()
        for (let warm = 0; warm < 64; warm++) {render()}
        const [left, right] = render()
        expect(left, "hard right: the left side is silent").toBeLessThan(0.001)
        expect(right, "hard right: the right side keeps the signal").toBeGreaterThan(0.4)
        sync.close()
    }, 60000)
})
