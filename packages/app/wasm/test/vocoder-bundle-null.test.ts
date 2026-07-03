// A LOCAL-ONLY full-bundle null test (skipped where the bundle is absent): renders /Users/am/Downloads/
// Vocoder.odb through BOTH engines and asserts the difference stays a deep null. Catches any one-sided
// numerical drift (e.g. a fast-math or SIMD change applied to only one engine).
import {describe, expect, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {decodeBundle} from "../src/bundle"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"

const QUANTA = 800
const PATH = "/Users/am/Downloads/Vocoder.odb"

describe.skipIf(!existsSync(PATH))("vocoder bundle null test", () => {
    it("full-mix TS vs WASM stays a deep null", async () => {
        const raw = readFileSync(PATH)
        const bundle = await decodeBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, bundle.boxGraph)
        await sync.settle(); engine.bind(); await sync.settle()
        const byUuid = new Map<string, ArrayBuffer>()
        for (const sample of bundle.samples) {byUuid.set(UUID.toString(sample.uuid), sample.wav)}
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(requestPtr, requestPtr + 16)) as UUID.Bytes)
            const wav = byUuid.get(uuid)
            if (wav === undefined) {engine.sample_allocate(handle, 4); engine.sample_set_ready(handle, 1, 1, 48000); continue}
            const audio = WavFile.decodeFloats(wav)
            const pointer = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
            for (let channel = 0; channel < audio.numberOfChannels; channel++) {
                new Float32Array(memory.buffer, pointer + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
            }
            engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
        }
        await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        engine.stop(); engine.play()
        const wasm = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            wasm.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        const ts = await renderTs(bundle.project, buildSampleMap(bundle.samples), QUANTA)
        const rms = (a: Float32Array) => {let s = 0; for (let i = 0; i < a.length; i++) {s += a[i] * a[i]} return Math.sqrt(s / a.length)}
        let diff = 0, maxd = 0
        const n = Math.min(wasm.length, ts.buffer.length)
        for (let i = 0; i < n; i++) {const d = wasm[i] - ts.buffer[i]; diff += d * d; maxd = Math.max(maxd, Math.abs(d))}
        const wr = rms(wasm), tr = rms(ts.buffer), dr = Math.sqrt(diff / n)
        const residual = 20 * Math.log10(dr / wr)
        console.log(`NULL wasm=${wr.toExponential(4)} ts=${tr.toExponential(4)} residual=${residual.toFixed(1)}dB maxDiff=${maxd.toExponential(2)}`)
        expect(wr).toBeGreaterThan(0.01, "the render is audible")
        expect(residual).toBeLessThan(-60, "TS and WASM stay a deep null on a real bundle")
    }, 120000)
})
