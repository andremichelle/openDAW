// End-to-end audible proof of AUDIO-REGION playback: build a minimal project (one audio unit whose instrument
// is a TapeDeviceBox, with one audio track holding one AudioRegionBox over a loaded file), drive it through the
// real engine, and assert the region actually SOUNDS — and that muting it silences the project (the region is
// the only source). This exercises the whole new path: the audio-track cascade -> AudioRegionPlayer read head ->
// Wired::Tape -> channel strip -> master.

import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
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
            box.position.setValue(0)        // plays from the very start
            box.duration.setValue(3840)     // one bar
            box.loopDuration.setValue(3840)
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
        expect(playing.peak).toBeGreaterThan(0.01) // the region is AUDIBLE

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
})
