// Where does the per-voice cost actually go? Render N audio voices through the FULL engine (engine.render()
// per quantum, real device modules) and time it — Signalsmith play-mode vs native (no stretch). Compares the
// per-voice increment so we know if the studio's ~13%/voice is the Signalsmith DSP or general engine overhead.
import {describe, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BAR = 3840
const BUDGET_MS = 128 / 48000 * 1000 // one render quantum's real-time budget

const buildVoice = (source: any, root: any, bus: any, index: number, signalsmith: boolean): void => {
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(root.audioUnits); box.output.refer(bus.input); box.index.setValue(index + 1)
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
        box.position.setValue(0); box.duration.setValue(64 * BAR); box.loopOffset.setValue(0); box.loopDuration.setValue(2 * BAR)
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    if (signalsmith) {
        const sig = AudioSignalsmithBox.create(source, UUID.generate())
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(0); box.seconds.setValue(0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(2 * BAR); box.seconds.setValue(1.0)})
        region.playMode.refer(sig)
    }
}

const measure = async (count: number, signalsmith: boolean, label: string): Promise<void> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    for (let i = 0; i < count; i++) buildVoice(source, rootBox, primaryAudioBusBox, i, signalsmith)
    source.endTransaction()
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    drainSamples()
    engine.stop(); engine.play()
    const readOut = (): number => {
        const frames = 128, pointer = engine.output_ptr()
        const left = new Float32Array(memory.buffer, pointer, frames)
        let sum = 0; for (let i = 0; i < frames; i++) sum += Math.abs(left[i]); return sum
    }
    for (let i = 0; i < 400; i++) engine.render() // warm + get past the startup burst
    const quanta = 4000
    let outSum = 0
    const times: number[] = []
    const t0 = performance.now()
    for (let i = 0; i < quanta; i++) {
        const q0 = performance.now(); engine.render(); times.push(performance.now() - q0)
        if (i % 8 === 0) outSum += readOut()
    }
    const ms = performance.now() - t0
    const perQuantum = ms / quanta
    times.sort((a, b) => b - a)
    const peak = times.slice(0, 16).reduce((sum, dt) => sum + dt, 0) / 16 // robust peak: mean of top-16 (drops OS hiccups)
    console.log(`${label.padEnd(24)} avg ${(perQuantum / BUDGET_MS * 100).toFixed(1)}%  peak ${(peak / BUDGET_MS * 100).toFixed(1)}%  (${perQuantum.toFixed(3)} ms)  out=${outSum.toFixed(1)}`)
    sync.close()
}

describe("signalsmith voices perf", () => {
    it("measures the per-voice engine cost", async () => {
        await measure(0, false, "0 voices (engine floor)")
        await measure(1, true, "1 signalsmith voice")
        await measure(3, true, "3 signalsmith voices")
        await measure(5, true, "5 signalsmith voices")
        await measure(3, false, "3 native voices")
    }, 120000)
})
