// The decisive calibration: compare the wasm render AND my headless TS-harness render of Chaotics against the
// GROUND-TRUTH studio-exported WAV, over the first several seconds (all from transport position 0). Per-second
// RMS tells us who is right: if the wasm tracks the WAV, the wasm is correct; if the TS harness is louder than
// the WAV, my harness over-renders; the gap between wasm and WAV is the real deficit the user hears.
import {describe, expect, it} from "vitest"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeBundle} from "../src/bundle"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"

const SECONDS = 8
const QUANTA = Math.ceil((SECONDS * 48000) / 128)

const loadBundle = () => {
    const b = readFileSync("/tmp/chaotics.odb")
    return decodeBundle(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

// Interleaved-planar (L|R per quantum) mono-sum RMS per second.
const perSecondRms = (buffer: Float32Array, planar: boolean): number[] => {
    const out: number[] = []
    const half = 128
    const perQ = planar ? half * 2 : half * 2
    const quantaPerSec = Math.floor(48000 / 128)
    let q = 0
    while ((q + quantaPerSec) * perQ <= buffer.length) {
        let sum = 0, n = 0
        for (let qq = q; qq < q + quantaPerSec; qq++) {
            for (let i = 0; i < perQ; i++) {const v = buffer[qq * perQ + i]; sum += v * v; n++}
        }
        out.push(Math.sqrt(sum / n))
        q += quantaPerSec
    }
    return out
}

const renderWasm = async (bg: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, bg)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const rp = engine.input_reserve(16)
        const h = engine.sample_take_request(rp)
        if (h < 0) {break}
        const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(rp, rp + 16)) as UUID.Bytes)
        const s = samples.find(x => UUID.toString(x.uuid) === uuid)
        if (s === undefined) {engine.sample_allocate(h, 4); engine.sample_set_ready(h, 1, 1, 48000); continue}
        const a = WavFile.decodeFloats(s.wav)
        const p = engine.sample_allocate(h, a.numberOfFrames * a.numberOfChannels * 4)
        for (let c = 0; c < a.numberOfChannels; c++) {new Float32Array(memory.buffer, p + c * a.numberOfFrames * 4, a.numberOfFrames).set(a.frames[c])}
        engine.sample_set_ready(h, a.numberOfFrames, a.numberOfChannels, a.sampleRate)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const buffer = new Float32Array(QUANTA * len)
    for (let q = 0; q < QUANTA; q++) {
        engine.render()
        buffer.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return buffer
}

describe.skipIf(!existsSync("/tmp/chaotics.odb") || !existsSync("/tmp/chaotics.wav"))("chaotics vs studio", () => {
    it("wasm + TS-harness vs the studio WAV (per-second RMS)", async () => {
        const wav = readFileSync("/tmp/chaotics.wav")
        const wavData = WavFile.decodeFloats(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer)
        // WAV per-second RMS (both channels), first SECONDS seconds.
        const wavRms: number[] = []
        for (let s = 0; s < SECONDS; s++) {
            let sum = 0, n = 0
            for (let i = s * 48000; i < (s + 1) * 48000; i++) {
                for (let c = 0; c < wavData.numberOfChannels; c++) {const v = wavData.frames[c][i]; sum += v * v; n++}
            }
            wavRms.push(Math.sqrt(sum / n))
        }
        const wasm = await renderWasm((await loadBundle()).boxGraph, (await loadBundle()).samples)
        const bundleTs = await loadBundle()
        const ts = await renderTs(ProjectSkeleton.encode(bundleTs.boxGraph), buildSampleMap(bundleTs.samples), QUANTA)
        const wasmRms = perSecondRms(wasm, true).slice(0, SECONDS)
        const tsRms = perSecondRms(ts.buffer, true).slice(0, SECONDS)
        const lines: string[] = ["sec  WAV      WASM     TS-harness   wasm-wav  ts-wav (dB)"]
        for (let s = 0; s < SECONDS; s++) {
            const ww = wavRms[s] > 1e-6 ? (20 * Math.log10(wasmRms[s] / wavRms[s])).toFixed(1) : "-"
            const tw = wavRms[s] > 1e-6 ? (20 * Math.log10(tsRms[s] / wavRms[s])).toFixed(1) : "-"
            lines.push(`${s}    ${wavRms[s].toExponential(2)} ${wasmRms[s].toExponential(2)} ${tsRms[s].toExponential(2)}   ${ww}    ${tw}`)
        }
        writeFileSync("/tmp/chaotics-vs-studio.txt", lines.join("\n") + "\n")
        expect(wasmRms.length).toBe(SECONDS)
    }, 180000)
})
