// Parity: the WASM script bridge must run a Werkstatt (scriptable audio effect) user `Processor` IDENTICALLY to
// invoking that same `Processor` directly (which is exactly what the pure-TS engine does). The unit's instrument
// is a silent stock synth (just to wire the effect chain — a Tape unit bypasses the audio-fx chain); the
// Werkstatt script generates a deterministic, param-controlled signal (and reads `src`, exercising the input
// view). We compare the WASM engine's rendered output to the SAME user `Processor` run directly on the same
// blocks — they must null-test to ~0, proving the bridge delivers params + block boundaries + the I/O buffers to
// the script exactly like the TS engine, through the engine's dynamic param hub (the `@param`).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const AMP = 0.3
// Reads `src` (so the input view is exercised) and adds a deterministic, param-scaled tone — independent of the
// transport, so the reference is the same per quantum. The script default (0) deliberately DIFFERS from the
// param's value, so the test fails unless the engine actually delivers the static `amp` to the script.
const CODE = `// @param amp 0 0 1 linear
class Processor {
    amp = 0
    paramChanged(label, value) { if (label === "amp") this.amp = value }
    process({src, out}, {s0, s1}) {
        const [sl, sr] = src
        const [ol, orr] = out
        for (let i = s0; i < s1; i++) {
            const v = sl[i] + this.amp * Math.sin(i * 0.27)
            ol[i] = v
            orr[i] = sr[i] + this.amp * Math.sin(i * 0.27)
        }
    }
}`

describe("werkstatt parity", () => {
    it("runs the user effect identically to a direct (TS) invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        let werkstatt!: WerkstattDeviceBox
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)) // silent (no notes), wires the chain
        werkstatt = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + CODE)
        })
        WerkstattParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(werkstatt.parameters)
            box.label.setValue("amp")
            box.index.setValue(0)
            box.value.setValue(AMP)
            box.defaultValue.setValue(AMP)
        })
        source.endTransaction()
        const uuid = UUID.toString(werkstatt.address.uuid)

        // Seed the user script into the worklet global (as the app does via audioWorklet.addModule).
        new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, CODE))()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0 // planar L|R for one quantum
        const half = len / 2
        const QUANTA = 16
        engine.stop(); engine.play()
        const wasm = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            wasm.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        expect(wasm.some(sample => Math.abs(sample) > 0.01)).toBe(true) // the effect produced the generated signal

        // Reference: the SAME user Processor, run directly (the TS execution) on a silent input, per quantum.
        const proc = new (globalThis as any).openDAW.werkstattProcessors[uuid].create()
        proc.paramChanged?.("amp", AMP)
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
