// TS-vs-wasm parity for "test-files/env-bug.od" (user: clicks on overlapping notes with a MONO vapo).
// Two wasm defects: (1) the arpeggio sorted note-OFF before note-ON at an equal position — TS yields the
// step's ONs first, which keeps a mono synth legato across abutting steps; OFF-first emptied the held stack
// and forced a retrigger per step. (2) the mono strategy owned ONE voice, so that retrigger ran
// force_stop+start on the same object, resetting the envelope/VCA-smoother/osc-phase mid-waveform — a hard
// cut to 0.0 (the click). TS spawns a new voice per retrigger and the force-stopped one fades out over its
// ~3 ms VCA smoother; the mono strategy now holds a small pool mirroring that. This pins both: per-second
// RMS windows AND a max single-sample cap (an 18-frame zero notch barely moves RMS — the sample cap is the
// click detector).
import * as path from "node:path"
import {describe, expect, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const FILE = path.resolve(__dirname, "../../../../test-files/env-bug.od")
const QUANTA = 3000 // 8 s at 48 kHz / 128 frames
const RMS_TOLERANCE_DB = 0.1
const SAMPLE_TOLERANCE = 0.01 // the click was a 0.105 step; the legato render stays ~0.001

const decode = () => {
    const buffer = readFileSync(FILE)
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const renderWasm = async (quanta: number): Promise<Float32Array> => {
    const boxGraph = decode()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const length = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(quanta * length)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), length), quantum * length)
    }
    return output
}

describe.skipIf(!existsSync(FILE))("env-bug TS vs wasm (mono vapo + arp legato)", () => {
    it("matches every RMS window and never diverges by a click", async () => {
        const ts = await renderTs(ProjectSkeleton.encode(decode()), new Map(), QUANTA)
        const wasm = await renderWasm(QUANTA)
        const perSecond = 375 * 256
        for (let second = 0; second < 8; second++) {
            const from = second * perSecond, to = from + perSecond
            const rms = (buffer: Float32Array): number => {
                let sum = 0
                for (let index = from; index < to; index++) {sum += buffer[index] * buffer[index]}
                return Math.sqrt(sum / (to - from))
            }
            const delta = 20 * Math.log10(rms(wasm) / rms(ts.buffer))
            expect(Math.abs(delta), `second ${second} RMS delta ${delta.toFixed(3)} dB`).toBeLessThan(RMS_TOLERANCE_DB)
        }
        const worst = {index: 0, diff: 0}
        for (let index = 0; index < wasm.length; index++) {
            const diff = Math.abs(ts.buffer[index] - wasm[index])
            if (diff > worst.diff) {worst.index = index; worst.diff = diff}
        }
        expect(worst.diff, `max sample diff at ${(worst.index / 2 / 48000).toFixed(4)}s`).toBeLessThan(SAMPLE_TOLERANCE)
    }, 600000)
})
