// Regression for "Zeitgeist stopped working" (test-files/zeitgeist.od): a Zeitgeist MIDI effect in front of a
// PLAYFIELD instrument had no audible swing in the wasm engine. Root cause: `reconcile_composite` wired the
// unit's AUDIO-fx chain and strip but never `unit.midi`, so a COMPOSITE instrument's per-slot note sequencers
// pulled raw notes straight from the track sets — the unit-level midi-fx (Zeitgeist, Arp, Pitch, Velocity) was
// dropped. The leaf path (an Apparat etc.) folded it, which is why the synthetic zeitgeist-groove test passed.
// Fix: fold the unit's midi-fx into every composite child's note-pull base (wiring.rs/composite.rs). This renders
// the real file's Playfield twice — swinging (groove amount 0.6) vs straight (amount 0.5, the identity) — and
// asserts the swing actually changes the master output. Before the fix the two renders were BIT-IDENTICAL.
import * as path from "node:path"
import {describe, expect, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {GrooveShuffleBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const FILE = path.resolve(__dirname, "../../../../test-files/zeitgeist.od")
const QUANTA = 2000

const decode = (): BoxGraph => {
    const buffer = readFileSync(FILE)
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const noiseSamples = (boxGraph: BoxGraph): Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> => {
    const samples: Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> = []
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioFileBox") {continue}
        const frames = 24000
        const data = new Float32Array(new SharedArrayBuffer(frames * 4))
        let seed = 0x12345678
        for (let index = 0; index < frames; index++) {
            seed = (seed * 1664525 + 1013904223) >>> 0
            data[index] = ((seed / 0xFFFFFFFF) * 2 - 1) * Math.exp(-6 * index / frames) * 0.5
        }
        const wav = WavFile.encodeFloats({frames: [data], numberOfFrames: frames, numberOfChannels: 1, sampleRate: 48000})
        samples.push({uuid: box.address.uuid, wav})
    }
    return samples
}

const feedSamples = (engine: Awaited<ReturnType<typeof loadFullEngine>>["engine"], memory: WebAssembly.Memory, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>) => {
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const id = UUID.toString(new Uint8Array(memory.buffer.slice(reserve, reserve + 16)) as UUID.Bytes)
        const found = samples.find(sample => UUID.toString(sample.uuid) === id)
        const audio = WavFile.decodeFloats(found!.wav)
        const ptr = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, ptr + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
    }
}

const render = (engine: Awaited<ReturnType<typeof loadFullEngine>>["engine"], memory: WebAssembly.Memory, quanta: number): Float32Array => {
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(quanta * len)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
    }
    return output
}

const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let max = 0
    for (let index = 0; index < a.length; index++) {max = Math.max(max, Math.abs(a[index] - b[index]))}
    return max
}

describe.skipIf(!existsSync(FILE))("zeitgeist wasm swing", () => {
    const peak = (buffer: Float32Array): number => {
        let max = 0
        for (let index = 0; index < buffer.length; index++) {max = Math.max(max, Math.abs(buffer[index]))}
        return max
    }
    const renderWith = async (amount: number): Promise<Float32Array> => {
        const graph = decode()
        const samples = noiseSamples(graph)
        const grooveBox = graph.boxes().find(box => box.name === "GrooveShuffleBox"
            && (box as unknown as {pointerHub: {incoming(): ReadonlyArray<{box: {name: string}}>}}).pointerHub.incoming().some(entry => entry.box.name === "ZeitgeistDeviceBox")) as GrooveShuffleBox
        graph.beginTransaction()
        grooveBox.amount.setValue(amount)
        graph.endTransaction()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, graph)
        await sync.settle(); engine.bind(); await sync.settle()
        feedSamples(engine, memory, samples)
        await sync.settle()
        const output = render(engine, memory, QUANTA)
        sync.close()
        return output
    }
    it("swinging (amount 0.6) differs from straight (amount 0.5) — set before bind", async () => {
        const swung = await renderWith(0.6)
        const straight = await renderWith(0.5)
        console.log("SWUNG peak", peak(swung).toExponential(3), "MAX DIFF swung vs straight", maxDiff(swung, straight).toExponential(3))
        expect(peak(swung), "must be audible signal").toBeGreaterThan(0.01)
        expect(maxDiff(swung, straight), "swing must change the output").toBeGreaterThan(0.001)
    }, 120000)
})
