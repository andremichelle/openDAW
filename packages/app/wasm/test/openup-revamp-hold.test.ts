// Reproduces "Open Up sounds wrong — automation on the Revamp not keeping its last value when the region ends".
// A Revamp low-pass cutoff is automated by a value region that ENDS well before the (long) note. After the region
// ends, TS holds the region's OUTGOING value (a high, open cutoff -> the 440 Hz tone passes, loud). If the wasm
// reverts (to the static field / the loop-start value), the tone gets cut and the late window goes quiet. We
// compare the wasm against the TS engine (the reference) in the window AFTER the region ends.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, RevampDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 0.4, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const SWEEP = 480 // pulses: the value region [0, 480) opens the cutoff, then ENDS while the note keeps sounding.

const build = (): {source: BoxGraph, apparat: string} => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    const revamp = RevampDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects); box.index.setValue(0)
        box.lowPass.enabled.setValue(true); box.lowPass.order.setValue(2); box.lowPass.q.setValue(0.707)
        box.lowPass.frequency.setValue(80.0) // static field: a LOW cutoff (cuts 440 Hz) — the automation opens it
    })
    const noteTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const notes = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(notes.events); box.position.setValue(0); box.duration.setValue(100_000)
        box.pitch.setValue(69); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(noteTrack.regions); box.events.refer(notes.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    const freqTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Value); box.enabled.setValue(true); box.index.setValue(1)
        box.target.refer(revamp.lowPass.frequency); box.tracks.refer(unit.tracks)
    })
    const freqEvents = ValueEventCollectionBox.create(source, UUID.generate())
    ValueEventBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.value.setValue(0.2); box.index.setValue(0); box.slope.setValue(NaN)
        box.events.refer(freqEvents.events); InterpolationFieldAdapter.write(box.interpolation, Interpolation.Linear)
    })
    ValueEventBox.create(source, UUID.generate(), box => {
        box.position.setValue(SWEEP); box.value.setValue(0.9); box.index.setValue(1); box.slope.setValue(NaN)
        box.events.refer(freqEvents.events); InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
    })
    ValueRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.duration.setValue(SWEEP); box.loopDuration.setValue(SWEEP)
        box.regions.refer(freqTrack.regions); box.events.refer(freqEvents.owners)
    })
    source.endTransaction()
    return {source, apparat: UUID.toString(apparat.address.uuid)}
}

const registerScript = (apparat: string) =>
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparat, 1, SYNTH))()

// RMS over a quantum window [fromQ, toQ) of the wasm output (planar L|R, `len` per quantum).
const wasmWindowRms = async (source: BoxGraph, fromQ: number, toQ: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, n = 0
    for (let q = 0; q < toQ; q++) {
        engine.render()
        if (q < fromQ) {continue}
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; n++}
    }
    return Math.sqrt(sum / n)
}

const tsWindowRms = async (source: BoxGraph, fromQ: number, toQ: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map(), toQ)
    let sum = 0, n = 0
    for (let q = fromQ; q < toQ; q++) {
        for (let i = 0; i < 256; i++) {const v = ts.buffer[q * 256 + i]; sum += v * v; n++}
    }
    return Math.sqrt(sum / n)
}

describe("open up: revamp automation holds past region end", () => {
    it("after the value region ends, the cutoff holds its outgoing value (matches TS)", async () => {
        // The value region ends at pulse 480 ~= quantum 94 (120 bpm, 48k). The window 200..390 is well after it.
        const FROM = 200, TO = 390
        const tsProject = build(); registerScript(tsProject.apparat)
        const ts = await tsWindowRms(tsProject.source, FROM, TO)
        const wasmProject = build(); registerScript(wasmProject.apparat)
        const wasm = await wasmWindowRms(wasmProject.source, FROM, TO)
        const deltaDb = 20 * Math.log10(wasm / ts)
        require("node:fs").writeFileSync("/tmp/openup-hold.txt", `after region end (q${FROM}..${TO}): TS ${ts.toExponential(3)} WASM ${wasm.toExponential(3)} delta ${deltaDb.toFixed(2)} dB\n`)
        expect(ts).toBeGreaterThan(0.01) // TS holds the open cutoff -> the 440 Hz tone passes
        expect(Math.abs(deltaDb)).toBeLessThan(1.0) // the wasm must hold the same value, not revert
    }, 60000)
})
