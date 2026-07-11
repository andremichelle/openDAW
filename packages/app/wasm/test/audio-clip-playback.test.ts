// End-to-end audible proof of AUDIO-CLIP launching: a Tape unit whose only content is one AudioClipBox on
// its audio track (no timeline regions). Silent until the clip is LAUNCHED (schedule_clip_play resolves the
// track through the clip's `clips` pointer and starts the transport), audible while it plays (the clip's
// virtual region loops at the clip duration), and silent again after a scheduled STOP takes effect at the
// next boundary. Exercises: audio-clip binding -> ClipSequencer sections -> AudioRegionPlayer -> master.

import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioClipBox, AudioFileBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BAR = 3840

describe("audio-clip playback", () => {
    it("a launched audio clip sounds, a scheduled stop silences it at the boundary", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})

        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(1.0)
            box.fileName.setValue("synthetic")
        })
        const collection = ValueEventCollectionBox.create(source, UUID.generate())
        const clipBox = AudioClipBox.create(source, UUID.generate(), box => {
            box.clips.refer(track.clips)
            box.file.refer(file)
            box.duration.setValue(BAR)
            box.events.refer(collection.owners)
        })
        source.endTransaction()

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        expect(drainSamples()).toBeGreaterThan(0) // the clip's file loads (a synthetic tone)

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
        const scheduleUuid = (uuid: UUID.Bytes, call: () => void): void => {
            const pointer = engine.input_reserve(16)
            new Uint8Array(memory.buffer, pointer, 16).set(uuid)
            call()
        }

        // Nothing launched: the timeline is empty, playing renders silence.
        engine.stop(); engine.play()
        expect(peakOf(32)).toBe(0)

        // Launch the clip (also STARTS the transport per TS parity — reset first to prove it).
        engine.stop()
        scheduleUuid(clipBox.address.uuid, () => engine.schedule_clip_play())
        const playing = peakOf(64)
        console.log(`audio clip peak: ${playing.toFixed(4)}`)
        expect(playing).toBeGreaterThan(0.01) // the launched clip is AUDIBLE

        // The clip LOOPS at its duration: still audible after more than a bar.
        expect(peakOf(64)).toBeGreaterThan(0.01)

        // MUTED WHILE PLAYING: a muted audio clip is IGNORED (silent over a full clip cycle), and resumes
        // when unmuted — it stays launched throughout.
        source.beginTransaction(); clipBox.mute.setValue(true); source.endTransaction()
        await sync.settle()
        peakOf(32) // flush the render quantum straddling the edit
        expect(peakOf(750)).toBe(0)
        source.beginTransaction(); clipBox.mute.setValue(false); source.endTransaction()
        await sync.settle()
        expect(peakOf(750)).toBeGreaterThan(0.01)

        // A scheduled stop ends it at the next bar boundary: after rendering past it, silence returns.
        scheduleUuid(track.address.uuid, () => engine.schedule_clip_stop())
        peakOf(720) // render past the boundary (a bar is 2s at 120bpm = 750 quanta; changes land within)
        expect(peakOf(64)).toBe(0)

        // The stop transition reached the change queue for the UI back-channel.
        expect(engine.clip_changes_count()).toBeGreaterThan(0)
    }, 30000)
})
