// Renders "/tmp/open-up.odb" through the Rust engine with its REAL bundle samples, to get concrete data on the
// two reports: (1) a click at play start — measured as the largest sample-to-sample jump in the first ~20 ms;
// (2) Revamp automation — probed by rendering the mix with the af0d1246 automation track ENABLED vs DISABLED
// and confirming the outputs diverge over the automated span (i.e. the automation actually moves the signal).
import {describe, expect, it} from "vitest"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {decodeBundle} from "../src/bundle"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const registerScripts = (boxGraph: BoxGraph): void => {
    const configs: Record<string, {header: string, registry: string, fn: string}> = {
        ApparatDeviceBox: {header: "apparat", registry: "apparatProcessors", fn: "apparat"},
        WerkstattDeviceBox: {header: "werkstatt", registry: "werkstattProcessors", fn: "werkstatt"},
        SpielwerkDeviceBox: {header: "spielwerk", registry: "spielwerkProcessors", fn: "spielwerk"}
    }
    for (const box of boxGraph.boxes()) {
        const config = box instanceof ApparatDeviceBox ? configs.ApparatDeviceBox
            : box instanceof WerkstattDeviceBox ? configs.WerkstattDeviceBox
            : box instanceof SpielwerkDeviceBox ? configs.SpielwerkDeviceBox : undefined
        if (config === undefined) {continue}
        const code = (box as unknown as {code: {getValue(): string}}).code.getValue()
        const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
        if (match === null) {continue}
        new Function(ScriptCompiler.wrap(
            {headerTag: config.header, registryName: config.registry, functionName: config.fn},
            UUID.toString(box.address.uuid), parseInt(match[1]), code.slice(match[0].length)))()
    }
}

const loadBuffer = (): ArrayBuffer => {
    const buffer = readFileSync("/tmp/open-up.odb")
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

// Render `quanta` quanta of a decoded bundle, feeding each requested sample its REAL decoded PCM (planar), or a
// short silence for a sample the bundle omits (e.g. soundfont-derived). Returns interleaved-planar output.
const renderDecoded = async (boxGraph: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<{output: Float32Array, len: number, missing: number}> => {
    const byUuid = new Map<string, ArrayBuffer>()
    for (const sample of samples) {byUuid.set(UUID.toString(sample.uuid), sample.wav)}
    registerScripts(boxGraph)
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    let missing = 0
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(requestPtr, requestPtr + 16)) as UUID.Bytes)
        const wav = byUuid.get(uuid)
        if (wav === undefined) {
            missing++
            const frameCount = 1, channelCount = 1
            engine.sample_allocate(handle, frameCount * channelCount * 4)
            engine.sample_set_ready(handle, frameCount, channelCount, 48000)
            continue
        }
        const audio = WavFile.decodeFloats(wav)
        const frameCount = audio.numberOfFrames, channelCount = audio.numberOfChannels
        const pointer = engine.sample_allocate(handle, frameCount * channelCount * 4)
        for (let channel = 0; channel < channelCount; channel++) {
            const plane = new Float32Array(memory.buffer, pointer + channel * frameCount * 4, frameCount)
            plane.set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, frameCount, channelCount, audio.sampleRate)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return {output, len, missing}
}

describe("open up render", () => {
    it("renders the bundle with real samples; probes the play-start click", async () => {
        const QUANTA = 32
        const {boxGraph, samples} = await decodeBundle(loadBuffer())
        const {output, len, missing} = await renderDecoded(boxGraph, samples, QUANTA)
        console.log("SAMPLES", samples.length, "MISSING(fed silence)", missing)
        expect(output.every(value => Number.isFinite(value))).toBe(true)
        // Reconstruct the true L-channel time series (each quantum is planar [L(half)|R(half)]).
        const half = len >>> 1
        const left = new Float32Array(QUANTA * half)
        for (let q = 0; q < QUANTA; q++) {
            left.set(output.subarray(q * len, q * len + half), q * half)
        }
        // The largest genuine inter-sample jump, and the block index where it lands (to see if it's a boundary).
        let maxJump = 0, jumpAt = -1
        for (let i = 1; i < left.length; i++) {
            const jump = Math.abs(left[i] - left[i - 1])
            if (jump > maxJump) {maxJump = jump; jumpAt = i}
        }
        console.log("MAX L JUMP", maxJump.toFixed(5), "@sample", jumpAt, "(block", Math.floor(jumpAt / half),
            "offset", jumpAt % half, ")")
        // The per-block onset: the peak of each of the first 12 blocks, to see how the signal enters from silence.
        const blockPeaks: string[] = []
        for (let q = 0; q < 12; q++) {
            let peak = 0
            for (let i = 0; i < half; i++) {peak = Math.max(peak, Math.abs(left[q * half + i]))}
            blockPeaks.push(peak.toFixed(4))
        }
        console.log("L BLOCK PEAKS[0..11]", blockPeaks.join(" "))
    }, 120000)

    it("probes Revamp af0d1246 automation: enabled vs disabled diverges over the automated span", async () => {
        const QUANTA = 400
        // Baseline: automation as authored.
        const on = await decodeBundle(loadBuffer())
        const onRender = await renderDecoded(on.boxGraph, on.samples, QUANTA)
        // Disable the Value track that targets af0d1246 [14,10].
        const off = await decodeBundle(loadBuffer())
        let disabled = 0
        for (const box of off.boxGraph.boxes()) {
            if (box.name !== "TrackBox") {continue}
            const anyBox = box as unknown as {
                type: {getValue(): number}, enabled: {setValue(v: boolean): void}
                target: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
            }
            if (anyBox.type.getValue() !== 3) {continue}
            const addr = anyBox.target.targetAddress.unwrapOrNull()
            if (addr === null) {continue}
            if (UUID.toString(addr.uuid as UUID.Bytes).startsWith("af0d1246")
                && Array.from(addr.fieldKeys).join(",") === "14,10") {
                off.boxGraph.beginTransaction()
                anyBox.enabled.setValue(false)
                off.boxGraph.endTransaction()
                disabled++
            }
        }
        expect(disabled).toBe(1)
        const offRender = await renderDecoded(off.boxGraph, off.samples, QUANTA)
        // Per-quantum RMS difference between the two mixes: if the automation moves the high-bell, they diverge.
        const len = onRender.len
        let maxDiff = 0, diffAt = -1, sumDiff = 0
        for (let q = 0; q < QUANTA; q++) {
            let sum = 0
            for (let i = 0; i < len; i++) {
                const d = onRender.output[q * len + i] - offRender.output[q * len + i]
                sum += d * d
            }
            const rms = Math.sqrt(sum / len)
            sumDiff += rms
            if (rms > maxDiff) {maxDiff = rms; diffAt = q}
        }
        console.log("AUTOMATION on-vs-off maxQuantumRMSdiff", maxDiff.toExponential(3), "@quantum", diffAt,
            "meanRMSdiff", (sumDiff / QUANTA).toExponential(3))
        expect(onRender.output.every(Number.isFinite)).toBe(true)
        expect(offRender.output.every(Number.isFinite)).toBe(true)
    }, 240000)
})
