// Regression for the IR-swap glitch (a 20 dB hole while the new IR loaded): swaps the IR of a playing
// convolver and asserts the wet level never drops more than 3 dB below the pre-swap level, and the first
// quantum after the swap (begin_load + one load step) stays inside the audio budget. Also logs sample
// delivery (allocate + copy + ready) and per-quantum render times around the swap.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BUDGET_US = (128 / 48000) * 1e6
const RATE = 48000

const makeIr = (seconds: number, seed: number): Float32Array => {
    const frames = RATE * seconds
    const planes = new Float32Array(frames * 2)
    for (let i = 0; i < planes.length; i++) {
        seed = (seed * 48271) % 2147483647
        planes[i] = ((seed / 2147483647) * 2 - 1) * 0.05 * Math.exp(-i / (frames * 0.3))
    }
    return planes
}

// Broadband noise excitation: the wet RMS then tracks the IR energy (equal for the two normalized IRs), so a
// level hole is visible; a sine would only measure |H(f)| of the current IR mix, which differs per IR.
const NOISE_SYNTH = `class Processor {
    voices = []
    seed = 1
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        if (this.voices.length === 0) return
        const [l, r] = output
        for (let i = block.s0; i < block.s1; i++) {
            this.seed = (this.seed * 48271) % 2147483647
            const s = ((this.seed / 2147483647) * 2 - 1) * 0.3
            l[i] += s; r[i] += s
        }
    }
}`

const project = (seconds: number, normalize: boolean): {graph: BoxGraph, device: ConvolverDeviceBox} => {
    let device: ConvolverDeviceBox | null = null
    const graph = buildEffectProject(0.3, (source, unit) => {
        const file = AudioFileBox.create(source, UUID.generate(), fileBox => {
            fileBox.startInSeconds.setValue(0.0)
            fileBox.endInSeconds.setValue(seconds)
            fileBox.fileName.setValue("ir-a")
        })
        device = ConvolverDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.wet.setValue(0.0)
            box.dry.setValue(-96.0)
            box.normalize.setValue(normalize)
            box.file.refer(file)
        })
        return device
    }, NOISE_SYNTH)
    return {graph, device: device!}
}

const deliver = (engine: any, memory: WebAssembly.Memory, planes: Float32Array, frames: number, log: string[]): void => {
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const t0 = performance.now()
        const pointer = engine.sample_allocate(handle, planes.byteLength)
        const t1 = performance.now()
        new Float32Array(memory.buffer, pointer, planes.length).set(planes)
        const t2 = performance.now()
        engine.sample_set_ready(handle, frames, 2, RATE)
        const t3 = performance.now()
        log.push(`deliver ${(planes.byteLength / 1e6).toFixed(1)} MB: allocate ${((t1 - t0) * 1000).toFixed(0)} us, copy ${((t2 - t1) * 1000).toFixed(0)} us, ready ${((t3 - t2) * 1000).toFixed(0)} us, memory ${(memory.buffer.byteLength / 1e6).toFixed(0)} MB`)
    }
}

const measure = async (seconds: number, normalize: boolean): Promise<void> => {
    const log: string[] = []
    const {graph, device} = project(seconds, normalize)
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, graph)
    await sync.settle(); engine.bind(); await sync.settle()
    const frames = RATE * seconds
    deliver(engine, memory, makeIr(seconds, 7), frames, log)
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const len = engine.output_len() >>> 0
    for (let q = 0; q < 512; q++) {engine.render()}
    const steady = new Array<number>(64)
    const rmsBefore = new Array<number>(8)
    for (let q = 0; q < 64; q++) {
        const start = performance.now()
        engine.render()
        steady[q] = (performance.now() - start) * 1000
        if (q >= 56) {rmsBefore[q - 56] = rms(new Float32Array(memory.buffer, engine.output_ptr(), len))}
    }
    const irB = makeIr(seconds, 99)
    const cloneStart = performance.now()
    const cloned = structuredClone(irB)
    const cloneUs = (performance.now() - cloneStart) * 1000
    log.push(`structuredClone ${(cloned.byteLength / 1e6).toFixed(1)} MB: ${cloneUs.toFixed(0)} us`)
    // swap the IR: new AudioFileBox, re-point the file pointer, settle the sync, deliver, then time renders
    const swapStart = performance.now()
    graph.beginTransaction()
    const fileB = AudioFileBox.create(graph, UUID.generate(), fileBox => {
        fileBox.startInSeconds.setValue(0.0)
        fileBox.endInSeconds.setValue(seconds)
        fileBox.fileName.setValue("ir-b")
    })
    const fileA = device.file.targetVertex.unwrap().box
    device.file.refer(fileB)
    fileA.delete()
    graph.endTransaction()
    await sync.settle()
    log.push(`transaction + sync settle: ${((performance.now() - swapStart) * 1000).toFixed(0)} us`)
    const before = new Float32Array(memory.buffer, engine.output_ptr(), len).slice()
    deliver(engine, memory, irB, frames, log)
    const quanta = 48
    const times = new Array<number>(quanta)
    const rmsAfter = new Array<number>(quanta)
    const out = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        const start = performance.now()
        engine.render()
        times[q] = (performance.now() - start) * 1000
        const quantum = new Float32Array(memory.buffer, engine.output_ptr(), len)
        rmsAfter[q] = rms(quantum)
        out.set(quantum, q * len)
    }
    const steadyMax = Math.max(...steady)
    const jump = (buffer: Float32Array): number => {
        let max = 0
        for (let i = 2; i < buffer.length; i += 2) {max = Math.max(max, Math.abs(buffer[i] - buffer[i - 2]))}
        return max
    }
    const steadyJump = jump(before)
    const swapJump = jump(out.subarray(0, 4 * len))
    console.info(`\n=== IR ${seconds} s stereo, normalize=${normalize} ===`)
    log.forEach(line => console.info(line))
    console.info(`steady render: max ${steadyMax.toFixed(0)} us (${(steadyMax / BUDGET_US * 100).toFixed(0)}% budget)`)
    console.info(`after swap: ${times.slice(0, 32).map(value => value.toFixed(0)).join(" ")} us`)
    console.info(`first quantum after swap: ${times[0].toFixed(0)} us (${(times[0] / BUDGET_US * 100).toFixed(0)}% budget), worst of 48: ${Math.max(...times).toFixed(0)} us`)
    console.info(`wet discontinuity: steady max step ${steadyJump.toFixed(4)}, swap max step ${swapJump.toFixed(4)}`)
    const db = (value: number): string => (20 * Math.log10(Math.max(value, 1e-9))).toFixed(1)
    console.info(`rms dBFS before swap: ${rmsBefore.map(db).join(" ")}`)
    console.info(`rms dBFS after swap:  ${rmsAfter.map(db).join(" ")}`)
    const meanBefore = rmsBefore.reduce((sum, value) => sum + value, 0) / rmsBefore.length
    const floorAfter = Math.min(...rmsAfter)
    // no hole deeper than 6 dB: the new IR plays at min(old, new) gain until the L3 pipeline has flushed
    expect(floorAfter).toBeGreaterThan(meanBefore * 0.5)
    expect(times[0]).toBeLessThan(BUDGET_US)
}

const rms = (buffer: Float32Array): number => {
    let sum = 0
    for (let i = 0; i < buffer.length; i++) {sum += buffer[i] * buffer[i]}
    return Math.sqrt(sum / buffer.length)
}

describe("convolver IR swap timing", () => {
    it("2 s normalize", async () => measure(2, true), 60000)
    it("8 s normalize", async () => measure(8, true), 60000)
    it("8 s no normalize", async () => measure(8, false), 60000)
    it("16 s normalize", async () => measure(16, true), 60000)
})
