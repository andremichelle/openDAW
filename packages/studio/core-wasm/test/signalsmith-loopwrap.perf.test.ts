// Isolates the loop-wrap re-prime burst: one Signalsmith voice on a SHORT loop (frequent wraps), timing every
// render quantum. The re-prime burst (2-3 FFT frames at once) shows as quanta far above the steady frame cost.
// With the primed-state cache a wrap is a memcpy, so no quantum should burst.
import {describe, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BAR = 3840
const BUDGET_MS = 128 / 48000 * 1000

describe("signalsmith loop-wrap perf", () => {
    it("no re-prime burst at loop wraps", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
            box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0); box.endInSeconds.setValue(1.0); box.fileName.setValue("synthetic")
        })
        const collection = ValueEventCollectionBox.create(source, UUID.generate())
        const region = AudioRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0); box.duration.setValue(64 * BAR); box.loopOffset.setValue(0); box.loopDuration.setValue(BAR) // 1-bar loop = frequent wraps
            box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
        })
        const sig = AudioSignalsmithBox.create(source, UUID.generate())
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(0); box.seconds.setValue(0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(BAR); box.seconds.setValue(0.5)})
        region.playMode.refer(sig)
        source.endTransaction()
        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0); drainSamples()
        engine.stop(); engine.play()
        for (let i = 0; i < 400; i++) engine.render()
        const quanta = 6000
        const times: number[] = []
        for (let i = 0; i < quanta; i++) { const t0 = performance.now(); engine.render(); times.push(performance.now() - t0) }
        times.sort((a, b) => b - a)
        const pct = (dt: number) => (dt / BUDGET_MS * 100).toFixed(1)
        const bursts = times.filter(dt => dt / BUDGET_MS > 0.15).length // quanta above 15% budget = a re-prime burst
        console.log(`true max ${pct(times[0])}%  p99 ${pct(times[Math.floor(quanta * 0.01)])}%  median ${pct(times[Math.floor(quanta / 2)])}%  |  ${bursts} of ${quanta} quanta burst >15%`)
        sync.close()
        // Log-only measurement (like voices.perf): a wall-clock burst count is too noisy to assert under full-
        // suite load. The burst elimination is guarded deterministically by the bit-identical restore test in
        // engine (signalsmith_short_loop_tiles); the forced-reset A/B shows ~6 bursts vs 0 with the cache.
        void bursts
    }, 60000)
})
