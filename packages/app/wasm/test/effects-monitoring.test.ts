// EFFECTS-mode input monitoring (TS MonitoringMixProcessor mirror): staged live input is injected into the
// mapped unit's chain PRE-FX, runs through its effects + strip, and the unit's output lands in the monitor
// OUTPUT staging the worklet forwards. A StereoTool at -24 dB on the unit must attenuate the monitored
// signal — proof the input passes the effect chain, not a bypass.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SILENT = `class Processor { process(output, block) {} }`
const QUANTUM = 128

const build = (fxVolumeDb: number | null) => {
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
    if (fxVolumeDb !== null) {
        StereoToolDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(0); box.volume.setValue(fxVolumeDb)
        })
    }
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SILENT))()
    return {source, unit}
}

const setup = async (fxVolumeDb: number | null) => {
    const {source, unit} = build(fxVolumeDb)
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const mapUnit = (channels: [number, number] | null) => {
        if (channels === null) {
            engine.set_monitoring_map(0)
            return
        }
        const pointer = engine.input_reserve(24)
        new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
        const view = new DataView(memory.buffer, pointer, 24)
        view.setInt32(16, channels[0], true)
        view.setInt32(20, channels[1], true)
        engine.set_monitoring_map(1)
    }
    const renderMonitored = (): {monitorPeak: number} => {
        // Stage a constant 0.5 on channels 0/1 (the worklet writes fresh input each quantum), then render.
        const staging = new Float32Array(memory.buffer, engine.monitor_input_ptr(), 8 * QUANTUM)
        staging.fill(0.0)
        staging.fill(0.5, 0, QUANTUM * 2)
        engine.render()
        const staged = new Float32Array(memory.buffer, engine.monitor_output_ptr(), 8 * QUANTUM)
        let monitorPeak = 0
        for (let index = 0; index < QUANTUM * 2; index++) {monitorPeak = Math.max(monitorPeak, Math.abs(staged[index]))}
        return {monitorPeak}
    }
    return {engine, memory, mapUnit, renderMonitored}
}

describe("effects monitoring", () => {
    it("injects the staged input through the unit chain and returns the strip output", async () => {
        const {mapUnit, renderMonitored} = await setup(null)
        // Unmapped: nothing returns.
        expect(renderMonitored().monitorPeak).toBe(0)
        // Mapped stereo on channels 0/1: the input passes the (fx-less) chain to the strip at unity.
        mapUnit([0, 1])
        for (let warm = 0; warm < 4; warm++) {renderMonitored()} // let the strip ramps settle
        const {monitorPeak} = renderMonitored()
        expect(monitorPeak, "the live input returns through the unit").toBeGreaterThan(0.4)
        expect(monitorPeak).toBeLessThan(0.6)
        // Unmapping silences the return again.
        mapUnit(null)
        expect(renderMonitored().monitorPeak).toBe(0)
    }, 60000)

    it("the monitored input runs THROUGH the effect chain (a -24 dB StereoTool attenuates it)", async () => {
        const {mapUnit, renderMonitored} = await setup(-24)
        mapUnit([0, 1])
        for (let warm = 0; warm < 8; warm++) {renderMonitored()}
        const {monitorPeak} = renderMonitored()
        const expected = 0.5 * Math.pow(10, -24 / 20)
        expect(monitorPeak, "the fx applies to the monitored signal").toBeGreaterThan(expected * 0.5)
        expect(monitorPeak).toBeLessThan(expected * 2.0)
    }, 60000)
})
