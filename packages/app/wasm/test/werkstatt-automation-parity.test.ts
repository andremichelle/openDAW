// Parity: a Werkstatt (scriptable audio effect) whose `@param amp` is AUTOMATED by a value track. This exercises
// the plan's key reuse: a Value track targeting the child `WerkstattParameterBox.value` field flows through the
// engine's existing automation machinery (build_param_track / host_update_parameters), so the device's param hub
// delivers the curve value tagged PARAM_KIND_UNIT, and the bridge maps it through the SAME `@param` ValueMapping
// the TS engine uses. A non-identity range (0..2) makes the mapping observable: a constant curve at unit 0.7 must
// reach the script as 1.4. We render through WASM and compare to the SAME Processor with paramChanged(1.4) applied.
import {describe, expect, it} from "vitest"
import {UUID, ValueMapping} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {AudioUnitBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox, VaporisateurDeviceBox, TrackBox, WerkstattDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const DEFAULT = 0.3
const UNIT = 0.7 // the constant automation value (0..1) the curve holds
const MIN = 0, MAX = 2
const MAPPED = ValueMapping.linear(MIN, MAX).y(UNIT) // 1.4 — what the bridge must hand the script

// Reads `src` and adds a deterministic, param-scaled tone. `amp` starts at the script default and is overwritten
// by the (mapped) automation value via paramChanged — so if automation is NOT applied, WASM diverges from the ref.
const CODE = `// @param amp ${DEFAULT} ${MIN} ${MAX} linear
class Processor {
    amp = ${DEFAULT}
    paramChanged(label, value) { if (label === "amp") this.amp = value }
    process({src, out}, {s0, s1}) {
        const [sl, sr] = src
        const [ol, orr] = out
        for (let i = s0; i < s1; i++) {
            ol[i] = sl[i] + this.amp * Math.sin(i * 0.27)
            orr[i] = sr[i] + this.amp * Math.sin(i * 0.27)
        }
    }
}`

describe("werkstatt automation parity", () => {
    it("delivers an automated, mapped @param to the script identically to a direct invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        let werkstatt!: WerkstattDeviceBox
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)) // silent, wires the chain
        werkstatt = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + CODE)
        })
        const param = WerkstattParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(werkstatt.parameters)
            box.label.setValue("amp")
            box.index.setValue(0)
            box.value.setValue(DEFAULT)
            box.defaultValue.setValue(DEFAULT)
        })
        // Automate the param: a Value track targeting the param's `value` field, holding a constant unit curve.
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(param.value)
            box.tracks.refer(unit.tracks)
        })
        const events = ValueEventCollectionBox.create(source, UUID.generate())
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.value.setValue(UNIT)
            box.slope.setValue(NaN)
            box.index.setValue(0)
            box.events.refer(events.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
        })
        source.endTransaction()
        const uuid = UUID.toString(werkstatt.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, CODE))()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const QUANTA = 16
        engine.stop(); engine.play()
        const wasm = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            wasm.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        expect(wasm.some(sample => Math.abs(sample) > 0.01)).toBe(true)

        // Reference: the SAME Processor with the MAPPED automation value applied (the engine delivers unit 0.7,
        // the bridge maps it through the @param's linear(0,2) → 1.4 — the reference applies that directly).
        const proc = new (globalThis as any).openDAW.werkstattProcessors[uuid].create()
        proc.paramChanged?.("amp", MAPPED)
        const silent = new Float32Array(half)
        const reference = new Float32Array(wasm.length)
        for (let q = 0; q < QUANTA; q++) {
            const base = q * len
            const outL = reference.subarray(base, base + half)
            const outR = reference.subarray(base + half, base + len)
            proc.process({src: [silent, silent], out: [outL, outR]}, {index: 0, p0: 0, p1: 0, s0: 0, s1: half, bpm: 120, flags: 0})
        }

        expect(maxDiff(wasm, reference)).toBeLessThan(1e-6)
    }, 30000)
})
