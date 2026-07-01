// Parity: an Apparat (scriptable instrument) that plays a LOADED SAMPLE on note-on. A `// @sample osc` slot is
// reconciled into a WerkstattSampleBox child whose `file` points at an AudioFileBox; the engine's ScriptSampleHub
// resolves that to a sample handle and delivers it to the bridge via `host_script_sample`, and the bridge resolves
// its resident frames into `proc.samples.osc`. We load the SAME synthetic PCM the engine's drain handshake writes,
// render through the WASM engine, and compare to the SAME Apparat run directly with that PCM assigned and the note
// delivered at the start. This exercises the otherwise-untested sample-hub path (observe_sample_collection_field /
// ScriptSampleHub / host_script_sample) plus the bridge's per-block sample polling (async-ready transition).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioFileBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const PITCH = 60
const VELOCITY = 0.8

// A one-shot sampler: on note-on it plays the `osc` sample's frames forward at a low gain (the SimpleLimiter the
// bridge applies stays transparent below ~unity, so a no-limiter reference matches — same as apparat-notes-parity).
const CODE = `// @sample osc
class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, pos: 0, gain: velocity * 0.2}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        const sample = this.samples.osc
        if (!sample) { return }
        const data = sample.frames[0]
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = (voice.pos < data.length ? data[voice.pos] : 0) * voice.gain
                l[i] += s
                r[i] += s
                voice.pos++
            }
        }
    }
}`

describe("apparat sample parity", () => {
    it("plays a loaded sample identically to a direct (TS) invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + CODE)
        })
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(0.5)
            box.fileName.setValue("synthetic")
        })
        WerkstattSampleBox.create(source, UUID.generate(), box => {
            box.owner.refer(apparat.samples)
            box.label.setValue("osc")
            box.index.setValue(0)
            box.file.refer(file)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0)
            box.duration.setValue(10_000) // long: no note-off within the captured window
            box.pitch.setValue(PITCH)
            box.velocity.setValue(VELOCITY)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
        })
        source.endTransaction()
        const uuid = UUID.toString(apparat.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, CODE))()

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples() // load the synthetic PCM (220 Hz, 0.5 s, mono, amp 0.5) the engine queued for the AudioFileBox
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const QUANTA = 16
        engine.stop(); engine.play()
        const wasm = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            wasm.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        expect(wasm.some(sample => Math.abs(sample) > 0.01)).toBe(true) // the sample sounded

        // Reference: the SAME Apparat with the identical synthetic PCM assigned, note delivered at the start.
        const sampleRate = (globalThis as any).sampleRate as number
        const frameCount = Math.floor(sampleRate * 0.5)
        const pcm = new Float32Array(frameCount)
        for (let frame = 0; frame < frameCount; frame++) {
            pcm[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate)
        }
        const proc = new (globalThis as any).openDAW.apparatProcessors[uuid].create()
        proc.samples = {osc: {sampleRate, numberOfFrames: frameCount, numberOfChannels: 1, frames: [pcm]}}
        proc.noteOn(PITCH, VELOCITY, 0, 1)
        const reference = new Float32Array(wasm.length)
        for (let q = 0; q < QUANTA; q++) {
            const base = q * len
            const outL = reference.subarray(base, base + half)
            const outR = reference.subarray(base + half, base + len)
            proc.process([outL, outR], {index: 0, p0: 0, p1: 0, s0: 0, s1: half, bpm: 120, flags: 0})
        }

        expect(maxDiff(wasm, reference)).toBeLessThan(1e-6)
    }, 30000)
})
