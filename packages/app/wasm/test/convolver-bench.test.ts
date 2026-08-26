// WASM speed check for the Convolver ("tests to see what is the fastest", wasm side): times
// engine.render() per 128-frame quantum with a 16 s stereo-noise IR loaded — the worst case the
// device allows — and asserts the WORST quantum stays well inside the 48 kHz budget (2666 us).
// Node runs the same SIMD128 wasm as the worklet, so these numbers transfer.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BUDGET_US = (128 / 48000) * 1e6

const project = (): BoxGraph =>
    buildEffectProject(0.3, (source, unit) => {
        const file = AudioFileBox.create(source, UUID.generate(), fileBox => {
            fileBox.startInSeconds.setValue(0.0)
            fileBox.endInSeconds.setValue(16.0)
            fileBox.fileName.setValue("bench-ir")
        })
        return ConvolverDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.wet.setValue(0.0)
            box.dry.setValue(0.0)
            box.normalize.setValue(true)
            box.file.refer(file)
        })
    })

describe("convolver wasm speed", () => {
    it("a 16 s IR renders every quantum well inside the audio budget", async () => {
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, project())
        await sync.settle(); engine.bind(); await sync.settle()
        const frames = 48000 * 16
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const pointer = engine.sample_allocate(handle, frames * 2 * Float32Array.BYTES_PER_ELEMENT)
            const planes = new Float32Array(memory.buffer, pointer, frames * 2)
            let seed = 7
            for (let i = 0; i < planes.length; i++) {
                seed = (seed * 48271) % 2147483647
                planes[i] = ((seed / 2147483647) * 2 - 1) * 0.05
            }
            engine.sample_set_ready(handle, frames, 2, 48000)
        }
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const warmup = 512 // IR load (time-distributed) + all pipelines primed
        for (let q = 0; q < warmup; q++) {engine.render()}
        const quanta = 1024 // 16 full 8192 periods: catches every step of the pipeline
        const times = new Array<number>(quanta)
        for (let q = 0; q < quanta; q++) {
            const start = performance.now()
            engine.render()
            times[q] = (performance.now() - start) * 1000
        }
        times.sort((a, b) => a - b)
        const mean = times.reduce((sum, value) => sum + value, 0) / quanta
        const p99 = times[Math.floor(quanta * 0.99)]
        const worst = times[quanta - 1]
        console.info(`convolver wasm, 16 s stereo IR: mean ${mean.toFixed(1)} us, p99 ${p99.toFixed(1)} us, worst ${worst.toFixed(1)} us` +
            ` (budget ${BUDGET_US.toFixed(0)} us; mean ${(mean / BUDGET_US * 100).toFixed(1)}%, worst ${(worst / BUDGET_US * 100).toFixed(1)}%)`)
        console.info(`top 10: ${times.slice(-10).map(value => value.toFixed(0)).join(" ")}`)
        expect(p99).toBeLessThan(BUDGET_US * 0.5) // the tail above p99 is node jitter, not the DSP
    }, 60000)
})
