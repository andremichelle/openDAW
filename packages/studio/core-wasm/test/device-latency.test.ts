// Devices report their latency (#482 phase 1): Compressor and Maximizer report their look-ahead (equal to the
// measured onset shift, updated on a runtime toggle), Fold its oversampling group delay, Autotune its PSOLA buffer.
import {describe, expect, it} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {AutotuneDeviceBox, CompressorDeviceBox, FoldDeviceBox, MaximizerDeviceBox} from "@opendaw/studio-boxes"
import type {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, leftChannel} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {readSignalGraph} from "../src/engine-exports"

type Device = { box: Box, setLookahead: (on: boolean) => void }

const compressor = (source: BoxGraph, unit: AudioUnitBox, lookahead: boolean): Device => {
    const box = CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.lookahead.setValue(lookahead)
        box.threshold.setValue(0.0)
        box.ratio.setValue(1.0)
        box.knee.setValue(0.0)
        box.inputgain.setValue(0.0)
        box.makeup.setValue(0.0)
        box.automakeup.setValue(false)
        box.mix.setValue(1.0)
    })
    return {box, setLookahead: on => box.lookahead.setValue(on)}
}

const maximizer = (source: BoxGraph, unit: AudioUnitBox, lookahead: boolean): Device => {
    const box = MaximizerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.lookahead.setValue(lookahead)
        box.threshold.setValue(0.0)
    })
    return {box, setLookahead: on => box.lookahead.setValue(on)}
}

const run = async (create: (source: BoxGraph, unit: AudioUnitBox, lookahead: boolean) => Device, lookahead: boolean) => {
    const holder: { device?: Device } = {}
    const source = buildEffectProject(0.5, (graph, unit) => {
        holder.device = create(graph, unit, lookahead)
        return holder.device.box
    })
    const device = holder.device!
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const quanta = 8
    const out = new Float32Array(quanta * len)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
    }
    const onset = leftChannel(out).findIndex(sample => Math.abs(sample) > 1.0e-6)
    const reported = () => {
        const graph = readSignalGraph(engine, memory)
        const node = graph.nodes.find(node => node.owner !== null && UUID.equals(node.owner, device.box.address.uuid))
        const master = graph.nodes.find(node => node.label === "master-sum")
        return {latency: node?.latency, master: master?.arrival}
    }
    const toggle = async (on: boolean) => {
        source.beginTransaction(); device.setLookahead(on); source.endTransaction()
        await sync.settle()
        engine.render()
    }
    return {onset, reported, toggle}
}

describe("device latency report", () => {
    for (const [name, create] of [["Compressor", compressor], ["Maximizer", maximizer]] as const) {
        it(`${name} reports exactly the onset shift of its look-ahead`, async () => {
            const off = await run(create, false)
            const on = await run(create, true)
            expect(off.reported()).toEqual({latency: 0, master: 0})
            expect(on.onset - off.onset).toBe(240)
            expect(on.reported()).toEqual({latency: 240, master: 240})
        }, 30000)
        it(`${name} updates its report when look-ahead toggles at runtime`, async () => {
            const session = await run(create, true)
            await session.toggle(false)
            expect(session.reported()).toEqual({latency: 0, master: 0})
            await session.toggle(true)
            expect(session.reported()).toEqual({latency: 240, master: 240})
        }, 30000)
    }
})

const noise = `class Processor {
    seed = 1
    on = false
    noteOn() { this.on = true }
    noteOff() {}
    process(output, block) {
        if (!this.on) return
        for (let i = block.s0; i < block.s1; i++) {
            this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0
            const s = (this.seed / 4294967296 - 0.5) * 0.1
            output[0][i] += s; output[1][i] += s
        }
    }
}`

const modulatedTone = `class Processor {
    t = 0
    on = false
    noteOn() { this.on = true }
    noteOff() {}
    process(output, block) {
        if (!this.on) return
        for (let i = block.s0; i < block.s1; i++) {
            const s = Math.sin(2 * Math.PI * 261.6256 * this.t / sampleRate) * (0.25 + 0.2 * Math.sin(2 * Math.PI * 7 * this.t / sampleRate))
            output[0][i] += s; output[1][i] += s; this.t++
        }
    }
}`

const renderWith = async (code: string, add?: (graph: BoxGraph, unit: AudioUnitBox) => Box) => {
    const holder: { device?: Box } = {}
    const source = buildEffectProject(0.5, (graph, unit) => {
        holder.device = isDefined(add) ? add(graph, unit) : unit
        return holder.device
    }, code)
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const quanta = 160
    const out = new Float32Array(quanta * len)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
    }
    const graph = readSignalGraph(engine, memory)
    const node = graph.nodes.find(node => node.owner !== null && UUID.equals(node.owner, holder.device!.address.uuid))
    return {signal: leftChannel(out), latency: node?.latency ?? 0}
}

const bestLag = (reference: Float32Array, signal: Float32Array, maxLag: number, start: number): number => {
    const scores = Array.from({length: maxLag + 1}, (_, lag) => {
        let sum = 0
        for (let index = start; index < signal.length; index++) {sum += signal[index] * reference[index - lag]}
        return sum
    })
    return scores.indexOf(Math.max(...scores))
}

const envelope = (signal: Float32Array): Float32Array => {
    const window = 256
    const out = new Float32Array(signal.length)
    const state = {sum: 0}
    signal.forEach((sample, index) => {
        state.sum += Math.abs(sample) - (index >= window ? Math.abs(signal[index - window]) : 0)
        out[index] = state.sum
    })
    const mean = out.reduce((sum, value) => sum + value, 0) / out.length
    return out.map(value => value - mean)
}

describe("measured device latencies", () => {
    for (const factor of [0, 1, 2]) {
        it(`Fold oversampling index ${factor} reports the measured group delay`, async () => {
            const dry = await renderWith(noise)
            const fold = await renderWith(noise, (graph, unit) => FoldDeviceBox.create(graph, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.overSampling.setValue(factor)
                box.drive.setValue(0)
                box.volume.setValue(0)
            }))
            expect(fold.latency).toBe(bestLag(dry.signal, fold.signal, 128, 4096))
        }, 30000)
    }
    it("Autotune reports the PSOLA buffer, the envelope lags it by less than one period", async () => {
        const dry = await renderWith(modulatedTone)
        const tuned = await renderWith(modulatedTone, (graph, unit) => AutotuneDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        }))
        expect(tuned.latency).toBe(1280)
        const lag = bestLag(envelope(dry.signal), envelope(tuned.signal), 3000, 8192)
        expect(Math.abs(tuned.latency - lag)).toBeLessThan(48000 / 261.6256)
    }, 30000)
})
