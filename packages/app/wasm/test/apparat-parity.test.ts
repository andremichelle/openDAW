// Parity: the WASM script bridge runs an Apparat (scriptable instrument) user `Processor` IDENTICALLY to a
// direct (TS) invocation. The instrument is a free-running, STATEFUL oscillator (phase persists across blocks),
// so this also proves the bridge keeps one user `Processor` instance across the whole render and zero-fills the
// output per block exactly like the TS `ApparatDeviceProcessor`. We render through the WASM engine and compare
// to the same `Processor` run directly, block by block (the limiter never engages at 0.2, so it is a no-op on
// both sides).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const CODE = `class Processor {
    phase = 0
    process(output, block) {
        const [l, r] = output
        for (let i = block.s0; i < block.s1; i++) {
            const v = 0.2 * Math.sin(this.phase)
            l[i] += v
            r[i] += v
            this.phase += 0.05
        }
    }
}`

describe("apparat parity", () => {
    it("runs the user instrument identically to a direct (TS) invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        let apparat!: ApparatDeviceBox
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + CODE)
        })
        source.endTransaction()
        const uuid = UUID.toString(apparat.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, CODE))()

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

        // Reference: the SAME user Processor run directly, one block per quantum, zero-filling output (as the
        // engine does) and accumulating phase across blocks.
        const proc = new (globalThis as any).openDAW.apparatProcessors[uuid].create()
        const reference = new Float32Array(wasm.length)
        for (let q = 0; q < QUANTA; q++) {
            const base = q * len
            const outL = reference.subarray(base, base + half)
            const outR = reference.subarray(base + half, base + len)
            proc.process([outL, outR], {index: 0, p0: 0, p1: 0, s0: 0, s1: half, bpm: 120, flags: 0})
        }

        expect(maxDiff(wasm, reference)).toBeLessThan(1e-6)
    }, 30000)
})
