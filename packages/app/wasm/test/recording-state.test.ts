// The engine-side RECORDING state machine (TS `EngineProcessor.#prepareRecordingState` mirror): a count-in
// runs the transport from `start - bars` with the metronome FORCED on, flips to recording at the start, and
// the EngineState bytes carry isCountingIn/isRecording/countInBeatsRemaining. `ignore_note_region` silences
// the region being recorded into; stop/pause clear everything.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [left, right] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const value = Math.sin(voice.phase * Math.PI * 2) * 0.5
                left[i] += value; right[i] += value
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const build = () => {
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
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    const region = NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
    return {source, region}
}

type State = {position: number, countInBeatsRemaining: number, isPlaying: boolean, isCountingIn: boolean, isRecording: boolean}

const readState = (engine: {engine_state_ptr(): number, engine_state_len(): number}, memory: WebAssembly.Memory): State => {
    const view = new DataView(memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
    return {
        position: view.getFloat32(0),
        countInBeatsRemaining: view.getFloat32(12),
        isPlaying: view.getUint8(16) === 1,
        isCountingIn: view.getUint8(17) === 1,
        isRecording: view.getUint8(18) === 1
    }
}

describe("recording state machine", () => {
    it("counts in with the metronome forced on, flips to recording, stop clears", async () => {
        const {source} = build()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0) // the preference is OFF: the count-in must still click
        engine.prepare_recording_state(1, 1.0) // one bar count-in at 4/4 = 3840 pulses
        const len = engine.output_len() >>> 0
        engine.render()
        const early = readState(engine, memory)
        expect(early.isPlaying).toBe(true)
        expect(early.isCountingIn).toBe(true)
        expect(early.isRecording).toBe(false)
        expect(early.position, "the playhead starts a bar early").toBeLessThan(-3000)
        expect(early.countInBeatsRemaining).toBeGreaterThan(3)
        expect(early.countInBeatsRemaining).toBeLessThanOrEqual(4)
        // The count-in clicks although the metronome preference is off.
        let clickPeak = 0
        let flipped: State | null = null
        for (let quantum = 0; quantum < 800; quantum++) {
            engine.render()
            const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
            const state = readState(engine, memory)
            if (state.isCountingIn) {
                for (let index = 0; index < len; index++) {clickPeak = Math.max(clickPeak, Math.abs(output[index]))}
            } else if (flipped === null) {
                flipped = state
            }
        }
        expect(clickPeak, "the count-in clicks with the metronome preference off").toBeGreaterThan(0.01)
        expect(flipped, "the count-in ends").not.toBeNull()
        expect(flipped!.isRecording, "counting-in flips to recording at the start").toBe(true)
        expect(flipped!.countInBeatsRemaining).toBe(0)
        expect(flipped!.position).toBeGreaterThanOrEqual(-128)
        // Seeks are ignored while recording (TS `#setPosition`).
        const before = readState(engine, memory).position
        engine.set_position(9999)
        engine.render()
        expect(readState(engine, memory).position, "seek ignored while recording").toBeLessThan(9999)
        expect(readState(engine, memory).position).toBeGreaterThan(before)
        // stop_recording pauses without rewinding and clears the flags.
        engine.stop_recording()
        engine.render()
        const stopped = readState(engine, memory)
        expect(stopped.isRecording).toBe(false)
        expect(stopped.isCountingIn).toBe(false)
        expect(stopped.isPlaying).toBe(false)
        expect(stopped.position, "stopRecording pauses in place").toBeGreaterThan(0)
    }, 60000)

    it("records immediately without count-in and pause ends it", async () => {
        const {source} = build()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.prepare_recording_state(0, 1.0)
        engine.render()
        const state = readState(engine, memory)
        expect(state.isRecording).toBe(true)
        expect(state.isCountingIn).toBe(false)
        expect(state.isPlaying).toBe(true)
        engine.pause()
        engine.render()
        expect(readState(engine, memory).isRecording, "pause ends recording (TS TimeInfo.pause)").toBe(false)
    }, 60000)

    it("an ignored note region emits nothing until the recording ends", async () => {
        const {source, region} = build()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        const peakOf = (quanta: number): number => {
            let peak = 0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (let index = 0; index < len; index++) {peak = Math.max(peak, Math.abs(output[index]))}
            }
            return peak
        }
        // Recording without count-in, the region marked as the recording target: it must not play back.
        const pointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, pointer, 16).set(region.address.uuid)
        engine.ignore_note_region()
        engine.prepare_recording_state(0, 1.0)
        expect(peakOf(64), "the ignored region is silent").toBe(0)
        // stop clears the ignore set: playing again sounds the region.
        engine.stop_recording()
        engine.stop()
        engine.play()
        expect(peakOf(64), "after recording the region plays again").toBeGreaterThan(0.01)
    }, 60000)
})
