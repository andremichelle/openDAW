// Muted timeline content must not sound — REGIONS and CLIPS, live-toggle included. Regions mirror TS
// (`NoteSequencer.#processRegions` / `TapeDeviceProcessor` / `TrackBoxAdapter.valueAt` all skip `mute`); for
// CLIPS both engines now skip a muted clip at the EMIT point too, so muting a clip WHILE IT PLAYS silences it
// (the launch button gating alone could not). Audio-region mute is covered by audio-region-playback.test.ts.
import {describe, expect, it} from "vitest"
import {UUID, ValueMapping} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueClipBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const AMP_UNIT = 0.7, AMP_MIN = 0, AMP_MAX = 2
const MAPPED = ValueMapping.linear(AMP_MIN, AMP_MAX).y(AMP_UNIT)

// A sine whose gain is the `amp` @param (default 0 = SILENT): the value-automation cases are audible only
// while their curve applies; the note cases set amp statically.
const CODE = `// @param amp 0 ${AMP_MIN} ${AMP_MAX} linear
class Processor {
    amp = 0
    voices = []
    paramChanged(label, value) { if (label === "amp") { this.amp = value } }
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [left, right] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const value = Math.sin(voice.phase * Math.PI * 2) * this.amp
                left[i] += value; right[i] += value
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

type Built = {
    source: BoxGraph
    noteRegion: NoteRegionBox
    noteClip: NoteClipBox
    valueRegion: ValueRegionBox
    valueClip: ValueClipBox
    ampParam: WerkstattParameterBox
}

const build = (): Built => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + CODE)
    })
    const ampParam = WerkstattParameterBox.create(source, UUID.generate(), box => {
        box.owner.refer(apparat.parameters); box.label.setValue("amp"); box.index.setValue(0)
        box.value.setValue(AMP_MIN); box.defaultValue.setValue(AMP_MIN)
    })
    const noteTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    // SHORT notes repeating each loop pass: after a mute the running note ends quickly (a note that already
    // STARTED rings to its natural end in BOTH engines) and then true silence proves no NEW starts.
    const regionNotes = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(regionNotes.events); box.position.setValue(0); box.duration.setValue(480)
        box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    const noteRegion = NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(noteTrack.regions); box.events.refer(regionNotes.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(960)
    })
    const clipNotes = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(clipNotes.events); box.position.setValue(0); box.duration.setValue(480)
        box.pitch.setValue(64); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    const noteClip = NoteClipBox.create(source, UUID.generate(), box => {
        box.clips.refer(noteTrack.clips); box.events.refer(clipNotes.owners); box.duration.setValue(960)
    })
    // The amp automation: a Value track on the param, one constant-curve region covering the timeline.
    const ampTrack = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Value); box.enabled.setValue(true); box.index.setValue(1)
        box.target.refer(ampParam.value); box.tracks.refer(unit.tracks)
    })
    // Incoming value 0 at position 0, stepping to AMP_UNIT at 960: a muted region resolves to the first
    // region's INCOMING value (TS `optAt(0)` reads it WITHOUT the mute filter) = 0 = silence.
    const ampEvents = ValueEventCollectionBox.create(source, UUID.generate())
    ValueEventBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.value.setValue(0); box.slope.setValue(NaN); box.index.setValue(0)
        box.events.refer(ampEvents.events)
        InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
    })
    ValueEventBox.create(source, UUID.generate(), box => {
        box.position.setValue(960); box.value.setValue(AMP_UNIT); box.slope.setValue(NaN); box.index.setValue(0)
        box.events.refer(ampEvents.events)
        InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
    })
    const valueRegion = ValueRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
        box.regions.refer(ampTrack.regions); box.events.refer(ampEvents.owners)
    })
    // A launchable VALUE clip on the amp track: a constant curve at AMP_UNIT. While launched it replaces the
    // timeline; muted it must resolve to the FIELD's storage value (AMP_MIN = silence).
    const clipAmpEvents = ValueEventCollectionBox.create(source, UUID.generate())
    ValueEventBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.value.setValue(AMP_UNIT); box.slope.setValue(NaN); box.index.setValue(0)
        box.events.refer(clipAmpEvents.events)
        InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
    })
    const valueClip = ValueClipBox.create(source, UUID.generate(), box => {
        box.clips.refer(ampTrack.clips); box.events.refer(clipAmpEvents.owners); box.duration.setValue(960)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, CODE))()
    return {source, noteRegion, noteClip, valueRegion, valueClip, ampParam}
}

const setup = async (built: Built) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, built.source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const peakOf = (quanta: number): number => {
        const len = engine.output_len() >>> 0
        let peak = 0
        for (let q = 0; q < quanta; q++) {
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let i = 0; i < len; i++) {
                expect(Number.isFinite(out[i])).toBe(true)
                if (Math.abs(out[i]) > peak) {peak = Math.abs(out[i])}
            }
        }
        return peak
    }
    const edit = async (apply: () => void) => {
        built.source.beginTransaction(); apply(); built.source.endTransaction()
        await sync.settle()
    }
    return {engine, memory, peakOf, edit}
}

describe("muted content stays silent", () => {
    it("a muted NOTE region emits no notes, live toggle included", async () => {
        const built = build()
        const {engine, peakOf, edit} = await setup(built)
        engine.stop(); engine.play()
        expect(peakOf(300)).toBeGreaterThan(0.01) // unmuted: audible once the amp curve steps up (pulse 960)
        await edit(() => built.noteRegion.mute.setValue(true))
        peakOf(200) // let the already-started note reach its natural end (480 pulses = 0.25 s)
        expect(peakOf(200)).toBe(0) // muted while playing: no new notes over a FULL loop cycle
        await edit(() => built.noteRegion.mute.setValue(false))
        expect(peakOf(400)).toBeGreaterThan(0.01) // unmuted again: notes return at the next loop pass
    }, 30000)

    it("a muted VALUE region applies no automation (the param falls back to its field value)", async () => {
        const built = build()
        const {engine, peakOf, edit} = await setup(built)
        engine.stop(); engine.play()
        expect(peakOf(300)).toBeGreaterThan(0.01) // the curve steps amp up at pulse 960: audible
        await edit(() => built.valueRegion.mute.setValue(true))
        peakOf(20) // the rebound curve reaches the script at the next update tick
        expect(peakOf(200)).toBe(0) // muted: the region's INCOMING value (0) applies over a FULL cycle
        await edit(() => built.valueRegion.mute.setValue(false))
        expect(peakOf(400)).toBeGreaterThan(0.01)
    }, 30000)

    it("a muted NOTE clip launches and schedules normally, it just emits no events", async () => {
        const built = build()
        const {engine, memory, peakOf, edit} = await setup(built)
        // Silence the timeline sources so only the clip sounds: mute the note region. Mute the CLIP too —
        // launching a muted clip must WORK (it plays silently; only event emission is suppressed).
        await edit(() => {built.noteRegion.mute.setValue(true); built.noteClip.mute.setValue(true)})
        engine.stop()
        const pointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, pointer, 16).set(built.noteClip.address.uuid)
        engine.schedule_clip_play()
        expect(peakOf(400)).toBe(0) // launched MUTED: scheduled + playing, but no events -> silence
        await edit(() => built.noteClip.mute.setValue(false))
        expect(peakOf(400)).toBeGreaterThan(0.01) // unmuting makes it sound WITHOUT re-launching: it WAS playing
        await edit(() => built.noteClip.mute.setValue(true))
        peakOf(200) // let the already-started note reach its natural end
        expect(peakOf(200)).toBe(0) // muted WHILE PLAYING: the clip stops emitting over a FULL cycle
    }, 30000)

    it("a muted VALUE clip resolves to the field's STORAGE value, live toggle included", async () => {
        const built = build()
        const {engine, memory, peakOf, edit} = await setup(built)
        // The launched value clip replaces the timeline curve: amp = AMP_UNIT everywhere, notes sound.
        engine.stop()
        const pointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, pointer, 16).set(built.valueClip.address.uuid)
        engine.schedule_clip_play()
        expect(peakOf(200)).toBeGreaterThan(0.01) // launched clip drives amp up: audible
        await edit(() => built.valueClip.mute.setValue(true))
        peakOf(20) // the rebound curve reaches the script at the next update tick
        expect(peakOf(200)).toBe(0) // muted: amp = the FIELD's storage value (AMP_MIN = 0) -> silence
        await edit(() => built.valueClip.mute.setValue(false))
        expect(peakOf(200)).toBeGreaterThan(0.01) // unmuted: the clip curve applies again (still launched)
    }, 30000)
})
