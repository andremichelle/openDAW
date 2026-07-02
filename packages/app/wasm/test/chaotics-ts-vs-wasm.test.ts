// TS-vs-wasm level check for "/tmp/chaotics.odb": many Nano synths are GROUPED into the "Music Wet" audio-unit
// bus, and the user reports the grouped tracks are ~3 dB too quiet while the direct sample track is fine. Confirms
// the delta and localizes it (full mix + per soloed instrument unit).
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

const load = () => {
    const b = readFileSync("/tmp/chaotics.odb")
    return decodeBundle(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

const instrumentNames = (bg: BoxGraph): Map<string, string> => {
    const m = new Map<string, string>()
    for (const x of bg.boxes()) {
        const h = (x as unknown as {host?: {targetAddress?: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}}).host
        const a = h?.targetAddress?.unwrapOrNull()
        if (a && Array.from(a.fieldKeys).join(",") === "22") {m.set(UUID.toString(a.uuid as UUID.Bytes), x.name)}
    }
    return m
}

const rmsWasm = async (bg: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<number> => {
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
    let sum = 0, n = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const o = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += o[i] * o[i]; n++}
    }
    return Math.sqrt(sum / n)
}

const rmsTs = async (bg: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<number> => {
    const r = await renderTs(ProjectSkeleton.encode(bg), buildSampleMap(samples), quanta)
    let sum = 0
    for (const v of r.buffer) {sum += v * v}
    return Math.sqrt(sum / r.buffer.length)
}

describe.skipIf(!existsSync("/tmp/chaotics.odb"))("chaotics TS vs wasm", () => {
    it("full mix + per-unit deltas", async () => {
        const Q = 400
        const full = await load()
        const ts = await rmsTs(full.boxGraph, full.samples, Q)
        const wasm = await rmsWasm(full.boxGraph, full.samples, Q)
        const lines: string[] = [`FULL MIX: TS ${ts.toExponential(3)} WASM ${wasm.toExponential(3)} -> ${(20 * Math.log10(wasm / ts)).toFixed(2)} dB`]
        // Per soloed instrument unit.
        const probe = await load()
        const names = instrumentNames(probe.boxGraph)
        const units = [...names.keys()]
        for (const keep of units) {
            const solo = (bg: BoxGraph) => {
                bg.beginTransaction()
                for (const box of bg.boxes()) {
                    if (box.name !== "AudioUnitBox") {continue}
                    const u = UUID.toString(box.address.uuid)
                    if (names.has(u) && u !== keep) {(box as unknown as {mute: {setValue(v: boolean): void}}).mute.setValue(true)}
                }
                bg.endTransaction()
            }
            const dt = await load(); solo(dt.boxGraph); const t = await rmsTs(dt.boxGraph, dt.samples, Q)
            const dw = await load(); solo(dw.boxGraph); const w = await rmsWasm(dw.boxGraph, dw.samples, Q)
            const d = t > 1e-6 ? (20 * Math.log10(w / t)).toFixed(2) : "n/a"
            lines.push(`unit ${keep.slice(0, 8)} (${names.get(keep)}): TS ${t.toExponential(3)} WASM ${w.toExponential(3)} -> ${d} dB`)
        }
        writeFileSync("/tmp/chaotics-cmp.txt", lines.join("\n") + "\n")
        expect(Number.isFinite(ts)).toBe(true)
    }, 300000)
})
