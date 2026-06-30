// End-to-end audible proof of AUDIO-REGION playback: build a minimal project (one audio unit whose instrument
// is a TapeDeviceBox, with one audio track holding one AudioRegionBox over a loaded file), drive it through the
// real engine, and assert the region actually SOUNDS — and that muting it silences the project (the region is
// the only source). This exercises the whole new path: the audio-track cascade -> AudioRegionPlayer read head ->
// Wired::Tape -> channel strip -> master.

import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioPitchStretchBox, AudioRegionBox, AudioTimeStretchBox, AudioUnitBox, TapeDeviceBox, TrackBox, TransientMarkerBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {TimeBase} from "@opendaw/lib-dsp"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

describe("audio-region playback", () => {
    it("a TapeDeviceBox unit plays its audio region, and muting the region silences it", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})

        let regionBox!: AudioRegionBox
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)) // the unit's instrument
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
        regionBox = AudioRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)                    // plays from the very start (ppqn, always)
            box.timeBase.setValue(TimeBase.Seconds)     // the REAL no-stretch (NoWarp) case: duration is in SECONDS
            box.duration.setValue(1.0)                  // 1 second of timeline (must be converted to ppqn, or it is silent)
            box.loopDuration.setValue(1.0)
            box.regions.refer(track.regions)
            box.file.refer(file)
            box.events.refer(collection.owners)
        })
        source.endTransaction()

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        expect(drainSamples()).toBeGreaterThan(0) // the region's file loads (a synthetic tone)

        const capture = (quanta: number): {peak: number, buffer: Float32Array} => {
            engine.stop(); engine.play()
            const len = engine.output_len() >>> 0
            const buffer = new Float32Array(quanta * len)
            let peak = 0
            for (let q = 0; q < quanta; q++) {
                engine.render()
                const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (let i = 0; i < len; i++) {
                    expect(Number.isFinite(out[i])).toBe(true)
                    if (Math.abs(out[i]) > peak) {peak = Math.abs(out[i])}
                }
                buffer.set(out, q * len)
            }
            return {peak, buffer}
        }

        const playing = capture(64)
        console.log(`audio region peak: ${playing.peak.toFixed(4)}`)
        expect(playing.peak).toBeGreaterThan(0.01) // the region is AUDIBLE (native playback)

        // PLAY-MODE must be respected, not ignored: give the region a PitchStretch play-mode whose warp markers
        // map 3840 ppqn -> 1.0 s (half-speed vs native), and assert the output CHANGES.
        source.beginTransaction()
        const pitch = AudioPitchStretchBox.create(source, UUID.generate())
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(pitch.warpMarkers); box.position.setValue(0); box.seconds.setValue(0.0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(pitch.warpMarkers); box.position.setValue(3840); box.seconds.setValue(1.0)})
        regionBox.playMode.refer(pitch)
        source.endTransaction()
        await sync.settle()
        const pitched = capture(64)
        console.log(`pitch-stretched peak: ${pitched.peak.toFixed(4)}`)
        expect(pitched.peak).toBeGreaterThan(0.01) // still audible
        expect(maxDiff(playing.buffer, pitched.buffer)).toBeGreaterThan(0.01) // the play-mode CHANGED the sound

        // Mute the region: it is the only source, so the project goes silent.
        source.beginTransaction()
        regionBox.mute.setValue(true)
        source.endTransaction()
        await sync.settle()
        const muted = capture(64)
        console.log(`muted peak: ${muted.peak.toFixed(6)}`)
        expect(muted.peak).toBeLessThan(playing.peak / 100) // muting silences it
        expect(maxDiff(playing.buffer, muted.buffer)).toBeGreaterThan(0.01) // and it really changed the output
    }, 30000)

    it("a TIME-STRETCH play-mode is respected: transient-aligned granular playback, audibly different from native", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})

        let regionBox!: AudioRegionBox
        let file!: AudioFileBox
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
        file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(1.0)
            box.fileName.setValue("synthetic")
        })
        // the source must carry >= 2 transient onsets (seconds) for the time-stretch sequencer to engage. They sit
        // close together (50 ms) so a granular SEGMENT ends INSIDE the capture window: a granular voice plays its
        // segment at native pitch, so the time-stretch diverges from the continuous native read only once it must
        // resync at a transient/segment boundary — which a distant transient would push past the window.
        TransientMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(file.transientMarkers); box.position.setValue(0.0)})
        TransientMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(file.transientMarkers); box.position.setValue(0.05)})
        const collection = ValueEventCollectionBox.create(source, UUID.generate())
        regionBox = AudioRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.timeBase.setValue(TimeBase.Seconds)
            box.duration.setValue(1.0)
            box.loopDuration.setValue(1.0)
            box.regions.refer(track.regions)
            box.file.refer(file)
            box.events.refer(collection.owners)
        })
        source.endTransaction()

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        expect(drainSamples()).toBeGreaterThan(0)

        const capture = (quanta: number): {peak: number, buffer: Float32Array} => {
            engine.stop(); engine.play()
            const len = engine.output_len() >>> 0
            const buffer = new Float32Array(quanta * len)
            let peak = 0
            for (let q = 0; q < quanta; q++) {
                engine.render()
                const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (let i = 0; i < len; i++) {
                    expect(Number.isFinite(out[i])).toBe(true)
                    if (Math.abs(out[i]) > peak) {peak = Math.abs(out[i])}
                }
                buffer.set(out, q * len)
            }
            return {peak, buffer}
        }

        const native = capture(64)
        console.log(`native peak: ${native.peak.toFixed(4)}`)
        expect(native.peak).toBeGreaterThan(0.01) // baseline: the region plays native

        // Attach a TIME-STRETCH play-mode (AudioTimeStretchBox): warp markers map 3840 ppqn -> 1.0 s of source
        // (a 0.5x stretch at 120 bpm). The engine must route this region through the transient-aligned granular
        // sequencer, NOT the native read head — so the output must change.
        source.beginTransaction()
        const stretch = AudioTimeStretchBox.create(source, UUID.generate(), box => {
            box.transientPlayMode.setValue(TransientPlayMode.Once)
            box.playbackRate.setValue(1.0)
        })
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(stretch.warpMarkers); box.position.setValue(0); box.seconds.setValue(0.0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(stretch.warpMarkers); box.position.setValue(3840); box.seconds.setValue(1.0)})
        regionBox.playMode.refer(stretch)
        source.endTransaction()
        await sync.settle()
        const stretched = capture(64)
        console.log(`time-stretched peak: ${stretched.peak.toFixed(4)}`)
        expect(stretched.peak).toBeGreaterThan(0.01) // the time-stretcher is AUDIBLE (not silent)
        expect(maxDiff(native.buffer, stretched.buffer)).toBeGreaterThan(0.01) // the play-mode CHANGED the sound
    }, 30000)
})
