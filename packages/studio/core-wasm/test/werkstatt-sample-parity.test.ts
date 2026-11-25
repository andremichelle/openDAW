// Parity: a Werkstatt (scriptable audio effect) that reads a LOADED SAMPLE. A `// @sample ir` slot is reconciled
// into a WerkstattSampleBox child whose `file` points at an AudioFileBox; the engine resolves it and delivers the
// handle through the device's `sample_changed`, and the bridge resolves its frames into `proc.samples.ir`. The
// script plays the sample's frames into its output, so the WASM render must match the SAME Processor run directly
// with that PCM assigned. Covers issue #353 (Werkstatt accepted @sample but never injected it).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const CODE = `// @sample ir
class Processor {
    pos = 0
    process({src, out}, {s0, s1}) {
        const [ol, orr] = out
        const sample = this.samples.ir
        for (let i = s0; i < s1; i++) {
            const s = sample && this.pos < sample.numberOfFrames ? sample.frames[0][this.pos++] * 0.2 : 0
            ol[i] = src[0][i] + s
            orr[i] = src[1][i] + s
        }
    }
}`

describe("werkstatt sample parity", () => {
    it("reads a loaded sample identically to a direct (TS) invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const werkstatt = WerkstattDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.code.setValue("// @werkstatt js 1 1\n" + CODE)
        })
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(0.5)
            box.fileName.setValue("synthetic")
        })
        WerkstattSampleBox.create(source, UUID.generate(), box => {
            box.owner.refer(werkstatt.samples)
            box.label.setValue("ir")
            box.index.setValue(0)
            box.file.refer(file)
        })
        source.endTransaction()
        const uuid = UUID.toString(werkstatt.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, CODE))()

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples()
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

        const sampleRate = (globalThis as any).sampleRate as number
        const frameCount = Math.floor(sampleRate * 0.5)
        const pcm = new Float32Array(frameCount)
        for (let frame = 0; frame < frameCount; frame++) {
            pcm[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate)
        }
        const proc = new (globalThis as any).openDAW.werkstattProcessors[uuid].create()
        proc.samples = {ir: {sampleRate, numberOfFrames: frameCount, numberOfChannels: 1, frames: [pcm]}}
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
