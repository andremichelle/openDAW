// One-off: render the user's studio project (hit.od) through the REAL wasm engine and dump the Neon box,
// to diff the studio path against the offline harness render of the same patch.
import {readFileSync, writeFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {NeonDeviceBox, TimelineBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SR = 48000

describe("hit.od studio render", () => {
    it("renders and dumps", async () => {
        const raw = readFileSync("/Users/am/Repositories/andre.michelle/openDAW/test-files/probe/synthlib/hit.od")
        const {boxGraph} = ProjectSkeleton.decode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
        for (const box of boxGraph.boxes()) {
            if (box instanceof TimelineBox) {
                boxGraph.beginTransaction()
                box.loopArea.enabled.setValue(false)
                boxGraph.endTransaction()
            }
            if (box instanceof NeonDeviceBox) {
                const envelope = box.envelopes.fields()[2]
                console.log("NEON:", JSON.stringify({
                    lineSelect: box.lineSelect.getValue(), modulation: box.modulation.getValue(),
                    octave: box.octave.getValue(), detune: box.detune.getValue(),
                    glide: box.glideTime.getValue(), voicing: box.voicingMode.getValue(),
                    vibrato: [box.vibrato.wave.getValue(), box.vibrato.delay.getValue(),
                        box.vibrato.rate.getValue(), box.vibrato.depth.getValue()],
                    lines: box.lines.fields().map(line => [line.wave1.getValue(), line.wave2.getValue(),
                        line.dcwKeyFollow.getValue(), line.dcaKeyFollow.getValue()]),
                    dcaL1: {rates: [envelope.rate1.getValue(), envelope.rate2.getValue(), envelope.rate3.getValue()],
                        levels: [envelope.level1.getValue(), envelope.level2.getValue(), envelope.level3.getValue()],
                        sustain: envelope.sustain.getValue(), end: envelope.end.getValue()}
                }))
            }
        }
        const {engine, memory} = await loadFullEngine(SR)
        const sync = connectSyncToEngine(engine, memory, boxGraph)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop()
        engine.play()
        const len = engine.output_len() >>> 0
        const frames = len / 2
        const quanta = Math.ceil((3.0 * SR) / frames)
        const mono = new Float32Array(quanta * frames)
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let index = 0; index < frames; index++) {
                mono[quantum * frames + index] = (out[index] + out[frames + index]) * 0.5
            }
        }
        const peak = mono.reduce((acc, value) => Math.max(acc, Math.abs(value)), 0)
        console.log("peak:", peak)
        const scale = peak > 0 ? 0.9 / peak : 1
        const bytes = new Uint8Array(44 + mono.length * 2)
        const view = new DataView(bytes.buffer)
        const writeAscii = (offset: number, text: string) => [...text].forEach((char, i) => bytes[offset + i] = char.charCodeAt(0))
        writeAscii(0, "RIFF"); view.setUint32(4, 36 + mono.length * 2, true); writeAscii(8, "WAVEfmt ")
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
        view.setUint32(24, SR, true); view.setUint32(28, SR * 2, true); view.setUint16(32, 2, true)
        view.setUint16(34, 16, true); writeAscii(36, "data"); view.setUint32(40, mono.length * 2, true)
        mono.forEach((value, index) => view.setInt16(44 + index * 2, Math.round(value * scale * 32767), true))
        writeFileSync("/Users/am/Downloads/neon-ab/studio-hit.wav", bytes)
        expect(peak).toBeGreaterThan(1e-4)
    }, 120_000)
})
