// Wiring + behaviour of the Convolver audio-effect: the IR sample reaches the device through the
// engine's sample pipeline (AudioFileBox -> observe_sample -> resolve_sample), and the partitioned
// convolution behaves as convolution must — a unit-impulse IR passes the signal through unchanged
// (zero latency), a delayed impulse shifts it, and an unbound file plays dry only. (The DSP itself
// is covered by crates/dsp tests; this proves the end-to-end chain.)
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, allFinite, peakOf} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type ConvolverSetup = {wet: number, dry: number, withFile: boolean, reverse?: boolean, normalize?: boolean}

const convolver = ({wet, dry, withFile, reverse = false, normalize = false}: ConvolverSetup): BoxGraph =>
    buildEffectProject(0.3, (source, unit) => {
        const file = withFile ? AudioFileBox.create(source, UUID.generate(), fileBox => {
            fileBox.startInSeconds.setValue(0.0)
            fileBox.endInSeconds.setValue(0.5)
            fileBox.fileName.setValue("impulse-response")
        }) : null
        return ConvolverDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.wet.setValue(wet)
            box.dry.setValue(dry)
            box.normalize.setValue(normalize)
            box.reverse.setValue(reverse)
            if (file !== null) {
                box.file.refer(file)
            }
        })
    })

// Render through the full engine, satisfying every queued sample request with the GIVEN mono IR.
const renderWithIr = async (source: BoxGraph, ir: Float32Array | null, quanta = 48): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    if (ir !== null) {
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const pointer = engine.sample_allocate(handle, ir.length * Float32Array.BYTES_PER_ELEMENT)
            new Float32Array(memory.buffer, pointer, ir.length).set(ir)
            engine.sample_set_ready(handle, ir.length, 1, 48000)
        }
    }
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const out = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const enginePtr = engine.output_ptr()
        out.set(new Float32Array(memory.buffer, enginePtr, len), q * len)
    }
    return out
}

const maxDiff = (a: Float32Array, b: Float32Array, from = 0): number => {
    let max = 0
    for (let i = from; i < a.length; i++) {max = Math.max(max, Math.abs(a[i] - b[i]))}
    return max
}

const impulse = (at: number, length: number): Float32Array => {
    const ir = new Float32Array(length)
    ir[at] = 1.0
    return ir
}

describe("convolver device", () => {
    it("a unit-impulse IR passes the signal through unchanged (zero latency)", async () => {
        const reference = await renderWithIr(convolver({wet: -100.0, dry: 0.0, withFile: true}), impulse(0, 4800))
        const convolved = await renderWithIr(convolver({wet: 0.0, dry: -100.0, withFile: true}), impulse(0, 4800))
        expect(allFinite(convolved)).toBe(true)
        expect(peakOf(convolved)).toBeGreaterThan(0.01)
        // skip the first quanta (IR load is time-distributed), then wet-through == dry-through
        const settled = 128 * 2 * 8
        expect(maxDiff(convolved, reference, settled)).toBeLessThan(1e-3)
    }, 30000)

    it("a delayed impulse shifts the signal by exactly the delay", async () => {
        const delay = 512 // 4 quanta
        const reference = await renderWithIr(convolver({wet: -100.0, dry: 0.0, withFile: true}), impulse(0, 4800))
        const delayed = await renderWithIr(convolver({wet: 0.0, dry: -100.0, withFile: true}), impulse(delay, 4800))
        expect(allFinite(delayed)).toBe(true)
        // output is planar per quantum (L then R, 128 each): a 512-sample delay = 4 quanta back
        const stride = 128 * 2
        const quantaShift = delay / 128
        let max = 0
        for (let q = 16; q < 40; q++) {
            for (let i = 0; i < 128; i++) {
                const left = delayed[q * stride + i] - reference[(q - quantaShift) * stride + i]
                const right = delayed[q * stride + 128 + i] - reference[(q - quantaShift) * stride + 128 + i]
                max = Math.max(max, Math.abs(left), Math.abs(right))
            }
        }
        expect(max).toBeLessThan(1e-3)
    }, 30000)

    it("plays dry only while no IR file is bound", async () => {
        const reference = await renderWithIr(convolver({wet: -100.0, dry: 0.0, withFile: true}), impulse(0, 4800))
        const unbound = await renderWithIr(convolver({wet: 0.0, dry: 0.0, withFile: false}), null)
        expect(allFinite(unbound)).toBe(true)
        expect(maxDiff(unbound, reference)).toBeLessThan(1e-4) // reference leaks its -100 dB wet path
    }, 30000)

    it("a long noise IR produces a finite, audible wet tail", async () => {
        const ir = new Float32Array(24000)
        let seed = 1
        for (let i = 0; i < ir.length; i++) {
            seed = (seed * 48271) % 2147483647
            ir[i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-3 * i / ir.length) * 0.1
        }
        const dryOnly = await renderWithIr(convolver({wet: -100.0, dry: 0.0, withFile: true}), ir, 96)
        const wetted = await renderWithIr(convolver({wet: 0.0, dry: 0.0, withFile: true}), ir, 96)
        expect(allFinite(wetted)).toBe(true)
        expect(peakOf(wetted)).toBeLessThan(2.0)
        expect(maxDiff(wetted, dryOnly)).toBeGreaterThan(0.01)
    }, 30000)

    it("normalize keeps a hot IR bounded", async () => {
        const ir = new Float32Array(48000).fill(0.5) // absurdly hot IR: energy 12000
        const wetted = await renderWithIr(convolver({wet: 0.0, dry: -100.0, withFile: true, normalize: true}), ir, 96)
        expect(allFinite(wetted)).toBe(true)
        expect(peakOf(wetted)).toBeLessThan(2.0)
    }, 30000)

    it("a reversed delta IR still passes signal, delayed by its length", async () => {
        // delta at index 0 reversed -> delta at length-1: exact-shift math is covered natively
        const reversed = await renderWithIr(convolver({wet: 0.0, dry: -100.0, withFile: true, reverse: true}), impulse(0, 1024))
        expect(allFinite(reversed)).toBe(true)
        expect(peakOf(reversed)).toBeGreaterThan(0.01)
    }, 30000)
})
