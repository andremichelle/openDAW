// The decisive TS-vs-wasm LEVEL comparison for "/tmp/ambition.odb": render the SAME project through the real
// TypeScript studio engine (headless) and the Rust/wasm engine, feeding BOTH the identical in-memory samples,
// and compare overall level (rms / peak). Ambition uses only wasm-ported devices + 3 samples (no soundfont /
// script / NAM), so the comparison is apples-to-apples.
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

const loadBuffer = (): ArrayBuffer => {
    const buffer = readFileSync("/tmp/ambition.odb")
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

// Map each AudioUnitBox uuid -> the box name of its input-host (22) instrument device.
const unitInstrumentNames = (boxGraph: BoxGraph): Map<string, string> => {
    const map = new Map<string, string>()
    for (const box of boxGraph.boxes()) {
        const host = (box as unknown as {host?: {targetAddress?: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}}).host
        if (host?.targetAddress === undefined) {continue}
        const addr = host.targetAddress.unwrapOrNull()
        if (addr === null || Array.from(addr.fieldKeys).join(",") !== "22") {continue}
        map.set(UUID.toString(addr.uuid as UUID.Bytes), box.name)
    }
    return map
}

// Mute every INSTRUMENT unit whose instrument device name is not `keep` (buses + output stay active).
const soloInstrumentType = (boxGraph: BoxGraph, keep: string): void => {
    const names = unitInstrumentNames(boxGraph)
    boxGraph.beginTransaction()
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioUnitBox") {continue}
        const uuid = UUID.toString(box.address.uuid)
        const instrument = names.get(uuid)
        if (instrument !== undefined && instrument !== keep) {
            (box as unknown as {mute: {setValue(v: boolean): void}}).mute.setValue(true)
        }
    }
    boxGraph.endTransaction()
}

// Force every audio region to NATIVE playback by deleting the time-stretch play-mode boxes (the region's
// playMode pointer then resolves to nothing -> native read head instead of the granular Pingpong sequencer).
const forceNativeTapes = (boxGraph: BoxGraph): number => {
    const stretchBoxes = boxGraph.boxes().filter(box => box.name === "AudioTimeStretchBox")
    boxGraph.beginTransaction()
    for (const box of stretchBoxes) {(box as unknown as {delete(): void}).delete()}
    boxGraph.endTransaction()
    return stretchBoxes.length
}

// Disable every device hosted on the OUTPUT unit (the master Compressor + Crusher), in the box graph.
const disableOutputEffects = (boxGraph: BoxGraph): void => {
    const outputUnit = boxGraph.boxes().find(box => box.name === "AudioUnitBox"
        && (box as unknown as {type: {getValue(): string}}).type.getValue() === "output")
    if (outputUnit === undefined) {return}
    const outputUuid = UUID.toString(outputUnit.address.uuid)
    boxGraph.beginTransaction()
    for (const box of boxGraph.boxes()) {
        const host = (box as unknown as {host?: {targetAddress?: {unwrapOrNull(): {uuid: Uint8Array} | null}}}).host
        if (host?.targetAddress === undefined) {continue}
        const addr = host.targetAddress.unwrapOrNull()
        if (addr !== null && UUID.toString(addr.uuid as UUID.Bytes) === outputUuid) {
            (box as unknown as {enabled: {setValue(v: boolean): void}}).enabled.setValue(false)
        }
    }
    boxGraph.endTransaction()
}

// Rust/wasm render of a decoded bundle, feeding the real samples.
const renderWasm = async (boxGraph: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<{rms: number, peak: number}> => {
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
    let sum = 0, peak = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; peak = Math.max(peak, Math.abs(out[i])); count++}
    }
    return {rms: Math.sqrt(sum / count), peak}
}

describe.skipIf(!existsSync("/tmp/ambition.odb"))("ambition TS vs wasm", () => {
    it("renders the TS studio engine headless (smoke)", async () => {
        const {project, samples} = await decodeBundle(loadBuffer())
        const ts = await renderTs(project, buildSampleMap(samples), 200)
        console.log("TS   rms", ts.rms.toExponential(3), "peak", ts.peak.toFixed(4))
        expect(Number.isFinite(ts.rms)).toBe(true)
    }, 120000)

    it("compares TS vs wasm overall level", async () => {
        const QUANTA = 400
        const decodedTs = await decodeBundle(loadBuffer())
        const ts = await renderTs(decodedTs.project, buildSampleMap(decodedTs.samples), QUANTA)
        const decodedWasm = await decodeBundle(loadBuffer())
        const wasm = await renderWasm(decodedWasm.boxGraph, decodedWasm.samples, QUANTA)
        const deltaDb = 20 * Math.log10(wasm.rms / ts.rms)
        const peakDb = 20 * Math.log10(wasm.peak / ts.peak)
        writeFileSync("/tmp/ambition-cmp.txt",
            `TS   rms ${ts.rms.toExponential(4)} peak ${ts.peak.toFixed(4)}\n` +
            `WASM rms ${wasm.rms.toExponential(4)} peak ${wasm.peak.toFixed(4)}\n` +
            `wasm-ts delta dB: rms ${deltaDb.toFixed(2)}  peak ${peakDb.toFixed(2)}\n`)
    }, 240000)

    it("bisect: TS vs wasm with the master Compressor+Crusher DISABLED", async () => {
        const QUANTA = 400
        // TS: disable master fx in the decoded graph, then RE-ENCODE the project bytes.
        const decodedTs = await decodeBundle(loadBuffer())
        disableOutputEffects(decodedTs.boxGraph)
        const projectOff = ProjectSkeleton.encode(decodedTs.boxGraph)
        const ts = await renderTs(projectOff, buildSampleMap(decodedTs.samples), QUANTA)
        // WASM: disable master fx in its own decoded graph.
        const decodedWasm = await decodeBundle(loadBuffer())
        disableOutputEffects(decodedWasm.boxGraph)
        const wasm = await renderWasm(decodedWasm.boxGraph, decodedWasm.samples, QUANTA)
        const deltaDb = 20 * Math.log10(wasm.rms / ts.rms)
        writeFileSync("/tmp/ambition-cmp-off.txt",
            `TS-off   rms ${ts.rms.toExponential(4)} peak ${ts.peak.toFixed(4)}\n` +
            `WASM-off rms ${wasm.rms.toExponential(4)} peak ${wasm.peak.toFixed(4)}\n` +
            `wasm-ts delta dB (master fx OFF): rms ${deltaDb.toFixed(2)}\n`)
        expect(Number.isFinite(ts.rms)).toBe(true)
    }, 240000)

    it("bisect: TS vs wasm per instrument type (master fx off)", async () => {
        const QUANTA = 400
        const lines: string[] = []
        for (const keep of ["VaporisateurDeviceBox", "TapeDeviceBox"]) {
            const decodedTs = await decodeBundle(loadBuffer())
            disableOutputEffects(decodedTs.boxGraph)
            soloInstrumentType(decodedTs.boxGraph, keep)
            const ts = await renderTs(ProjectSkeleton.encode(decodedTs.boxGraph), buildSampleMap(decodedTs.samples), QUANTA)
            const decodedWasm = await decodeBundle(loadBuffer())
            disableOutputEffects(decodedWasm.boxGraph)
            soloInstrumentType(decodedWasm.boxGraph, keep)
            const wasm = await renderWasm(decodedWasm.boxGraph, decodedWasm.samples, QUANTA)
            const deltaDb = 20 * Math.log10(wasm.rms / ts.rms)
            lines.push(`${keep}: TS rms ${ts.rms.toExponential(4)} / WASM rms ${wasm.rms.toExponential(4)} -> delta ${deltaDb.toFixed(2)} dB`)
        }
        writeFileSync("/tmp/ambition-bisect.txt", lines.join("\n") + "\n")
        expect(lines.length).toBe(2)
    }, 300000)

    it("bisect: Tape tracks with time-stretch FORCED NATIVE (master fx off)", async () => {
        const QUANTA = 400
        const decodedTs = await decodeBundle(loadBuffer())
        disableOutputEffects(decodedTs.boxGraph)
        soloInstrumentType(decodedTs.boxGraph, "TapeDeviceBox")
        const deleted = forceNativeTapes(decodedTs.boxGraph)
        const ts = await renderTs(ProjectSkeleton.encode(decodedTs.boxGraph), buildSampleMap(decodedTs.samples), QUANTA)
        const decodedWasm = await decodeBundle(loadBuffer())
        disableOutputEffects(decodedWasm.boxGraph)
        soloInstrumentType(decodedWasm.boxGraph, "TapeDeviceBox")
        forceNativeTapes(decodedWasm.boxGraph)
        const wasm = await renderWasm(decodedWasm.boxGraph, decodedWasm.samples, QUANTA)
        const deltaDb = 20 * Math.log10(wasm.rms / ts.rms)
        writeFileSync("/tmp/ambition-native.txt",
            `deleted ${deleted} time-stretch boxes\n` +
            `NATIVE-tapes: TS rms ${ts.rms.toExponential(4)} / WASM rms ${wasm.rms.toExponential(4)} -> delta ${deltaDb.toFixed(2)} dB\n`)
        expect(Number.isFinite(ts.rms)).toBe(true)
    }, 300000)

    it("bisect: TS vs wasm per SOLOED instrument unit (master fx off)", async () => {
        const QUANTA = 400
        const probe = await decodeBundle(loadBuffer())
        const names = unitInstrumentNames(probe.boxGraph)
        const unitUuids: string[] = []
        for (const box of probe.boxGraph.boxes()) {
            if (box.name !== "AudioUnitBox") {continue}
            const uuid = UUID.toString(box.address.uuid)
            if (names.has(uuid)) {unitUuids.push(uuid)} // only instrument units (have an input device)
        }
        const soloUnit = (boxGraph: BoxGraph, keep: string): void => {
            boxGraph.beginTransaction()
            for (const box of boxGraph.boxes()) {
                if (box.name !== "AudioUnitBox") {continue}
                const uuid = UUID.toString(box.address.uuid)
                if (names.has(uuid) && uuid !== keep) {(box as unknown as {mute: {setValue(v: boolean): void}}).mute.setValue(true)}
            }
            boxGraph.endTransaction()
        }
        const lines: string[] = []
        for (const keep of unitUuids) {
            const dTs = await decodeBundle(loadBuffer()); disableOutputEffects(dTs.boxGraph); soloUnit(dTs.boxGraph, keep)
            const ts = await renderTs(ProjectSkeleton.encode(dTs.boxGraph), buildSampleMap(dTs.samples), QUANTA)
            const dW = await decodeBundle(loadBuffer()); disableOutputEffects(dW.boxGraph); soloUnit(dW.boxGraph, keep)
            const wasm = await renderWasm(dW.boxGraph, dW.samples, QUANTA)
            const delta = ts.rms > 1e-6 ? (20 * Math.log10(wasm.rms / ts.rms)).toFixed(2) : "n/a"
            lines.push(`unit ${keep.slice(0, 8)} (${names.get(keep)}): TS ${ts.rms.toExponential(3)} WASM ${wasm.rms.toExponential(3)} -> ${delta} dB`)
        }
        writeFileSync("/tmp/ambition-per-unit.txt", lines.join("\n") + "\n")
        expect(lines.length).toBeGreaterThan(0)
    }, 240000)
})
