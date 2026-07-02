// Validates the SEND/RETURN feature against the real "/tmp/ambition.odb": two instruments route their output
// into the "Music Bus" (94c61d90) submix unit (ea4eb8f8), which feeds the master. Rendering as-is must be finite
// and audible; muting the Music-Bus UNIT must drop the mix (its two source instruments have no other path), which
// proves the submix routing actually carries their signal (before this feature it was silently dropped).
import {describe, expect, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {decodeBundle} from "../src/bundle"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const loadBuffer = (): ArrayBuffer => {
    const buffer = readFileSync("/tmp/ambition.odb")
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

const renderRms = async (boxGraph: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<{rms: number, peak: number, buffer: Float32Array}> => {
    const byUuid = new Map<string, ArrayBuffer>()
    for (const sample of samples) {byUuid.set(UUID.toString(sample.uuid), sample.wav)}
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
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
    const buffer = new Float32Array(quanta * len)
    let sum = 0, peak = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        buffer.set(out, q * len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; peak = Math.max(peak, Math.abs(out[i])); count++}
    }
    return {rms: Math.sqrt(sum / count), peak, buffer}
}

// Mute the "bus"-type AudioUnitBox whose input is the given AudioBusBox (the submix return unit).
const muteBusUnitFor = (boxGraph: BoxGraph, busUuidPrefix: string): boolean => {
    let busUnitUuid: string | null = null
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioBusBox") {continue}
        if (!UUID.toString(box.address.uuid).startsWith(busUuidPrefix)) {continue}
        const out = (box as unknown as {output: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array} | null}}}).output.targetAddress.unwrapOrNull()
        if (out !== null) {busUnitUuid = UUID.toString(out.uuid as UUID.Bytes)}
    }
    if (busUnitUuid === null) {return false}
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioUnitBox" || UUID.toString(box.address.uuid) !== busUnitUuid) {continue}
        boxGraph.beginTransaction()
        ;(box as unknown as {mute: {setValue(v: boolean): void}}).mute.setValue(true)
        boxGraph.endTransaction()
        return true
    }
    return false
}

// A local-only validation against a real bundle (not in the repo); skipped in CI where the file is absent.
describe.skipIf(!existsSync("/tmp/ambition.odb"))("ambition render", () => {
    it("renders finite + audible, and muting the Music-Bus submit unit drops the mix", async () => {
        const QUANTA = 200
        const on = await decodeBundle(loadBuffer())
        const onRender = await renderRms(on.boxGraph, on.samples, QUANTA)
        console.log("AMBITION as-is rms", onRender.rms.toExponential(3), "peak", onRender.peak.toFixed(4))
        expect(Number.isFinite(onRender.rms)).toBe(true)
        expect(onRender.peak).toBeGreaterThan(0.01) // audible

        const off = await decodeBundle(loadBuffer())
        expect(muteBusUnitFor(off.boxGraph, "94c61d90")).toBe(true) // the "Music Bus"
        const offRender = await renderRms(off.boxGraph, off.samples, QUANTA)
        console.log("AMBITION music-bus muted rms", offRender.rms.toExponential(3), "peak", offRender.peak.toFixed(4))
        expect(Number.isFinite(offRender.rms)).toBe(true)
        // The DIFFERENCE between the two renders IS the Music-Bus submix's contribution to the master. If the
        // submix routing carries its two instruments, that difference is an audible signal on its own.
        let diffSum = 0
        for (let i = 0; i < onRender.buffer.length; i++) {
            const delta = onRender.buffer[i] - offRender.buffer[i]
            diffSum += delta * delta
        }
        const diffRms = Math.sqrt(diffSum / onRender.buffer.length)
        console.log("AMBITION music-bus contribution rms", diffRms.toExponential(3))
        expect(diffRms).toBeGreaterThan(0.02) // the submix carries an audible signal through the bus path
    }, 120000)
})
