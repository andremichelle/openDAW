// Pitch and Grain audio regions through a groove in the FULL engine. An offset groove moves the whole content later,
// so the render equals the straight render delayed by the offset. A No Sync region has no groove, a pointer is ignored.
import {describe, expect, it} from "vitest"
import {int, Nullable, UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    GrooveOffsetBox,
    GrooveShuffleBox,
    TapeDeviceBox,
    TrackBox,
    TransientMarkerBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TimeBase} from "@opendaw/lib-dsp"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_PULSE = 25 // 48k, 120 bpm, 960 per quarter
const BAR = 3840

type Mode = "no-sync" | "pitch" | "grain"
type Setup = {mode: Mode, offset: Nullable<int>, shuffle?: boolean}

const render = async ({mode, offset, shuffle}: Setup, bars: int): Promise<Float32Array> => {
    const pitch = mode !== "no-sync"
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
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
    // off the block edges, a transient whose lookahead ends exactly on one fires a block apart from float drift alone
    for (const position of [0.0, 0.2604, 0.5104, 0.7604]) {
        TransientMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(file.transientMarkers); box.position.setValue(position)})
    }
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const region = AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0)
        box.timeBase.setValue(pitch ? TimeBase.Musical : TimeBase.Seconds)
        box.duration.setValue(pitch ? BAR : 2.0)
        box.loopDuration.setValue(pitch ? BAR : 2.0)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(collection.owners)
    })
    if (pitch) {
        const playMode = mode === "grain"
            ? AudioTimeStretchBox.create(source, UUID.generate(), box => {
                box.transientPlayMode.setValue(TransientPlayMode.Once)
                box.playbackRate.setValue(1.0)
            })
            : AudioPitchStretchBox.create(source, UUID.generate())
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(playMode.warpMarkers); box.position.setValue(0); box.seconds.setValue(0.0)})
        WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(playMode.warpMarkers); box.position.setValue(BAR); box.seconds.setValue(mode === "grain" ? 2.0 : 1.0)})
        region.playMode.refer(playMode)
    }
    if (offset !== null) {
        const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.offset.setValue(offset)
        })
        region.groove.refer(groove)
    }
    if (shuffle === true) {
        // the defaults: 60% over eighths
        const groove = GrooveShuffleBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
        })
        region.groove.refer(groove)
    }
    source.endTransaction()
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    expect(drainSamples()).toBeGreaterThan(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    const quanta = Math.ceil(bars * BAR * SAMPLES_PER_PULSE / half)
    const left = new Float32Array(quanta * half)
    for (let index = 0; index < quanta; index++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), index * half)
    }
    sync.close()
    return left
}

const peak = (samples: Float32Array): number => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)

describe("audio region through a groove", () => {
    it("a Pitch region through an offset groove is the straight region delayed", async () => {
        const straight = await render({mode: "pitch", offset: null}, 2)
        expect(peak(straight)).toBeGreaterThan(0.01)
        for (const offset of [120, 240]) {
            const shift = offset * SAMPLES_PER_PULSE
            const grooved = await render({mode: "pitch", offset}, 2)
            expect(peak(grooved.subarray(0, shift)), `offset ${offset}: silent before the content`).toBe(0)
            // away from both edges, where the declick and the region end differ
            let error = 0
            for (let index = shift + 2000; index < BAR * SAMPLES_PER_PULSE - 2000; index++) {
                error = Math.max(error, Math.abs(grooved[index] - straight[index - shift]))
            }
            expect(error, `offset ${offset}`).toBeLessThan(1e-4)
        }
    }, 300000)
    it("a Pitch region plays straight through a zero offset", async () => {
        const straight = await render({mode: "pitch", offset: null}, 1)
        const zero = await render({mode: "pitch", offset: 0}, 1)
        let error = 0
        straight.forEach((value, index) => error = Math.max(error, Math.abs(value - zero[index])))
        expect(error).toBeLessThan(1e-4)
    }, 300000)
    it("a Grain region through an offset groove is the straight region delayed", async () => {
        const straight = await render({mode: "grain", offset: null}, 2)
        expect(peak(straight)).toBeGreaterThan(0.01)
        // whole render quanta, so the transients fire in the same place of their quanta
        for (const offset of [128, 256]) {
            const shift = offset * SAMPLES_PER_PULSE
            const grooved = await render({mode: "grain", offset}, 2)
            expect(peak(grooved.subarray(0, shift - 1)), `offset ${offset}: silent before the content`).toBe(0)
            // the block positions carry float drift, so a voice may start a sample apart: compare the loudness
            // Grain plays the file at its own speed, a stretch places the straight transients up to 20 ms early
            const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
            for (let from = shift; from < BAR * SAMPLES_PER_PULSE / 2 - 2000; from += 500) {
                const error = Math.abs(rms(grooved.subarray(from, from + 500)) - rms(straight.subarray(from - shift, from - shift + 500)))
                expect(error, `offset ${offset} at ${from}`).toBeLessThan(0.005)
            }
        }
    }, 300000)
    it("a Grain region cuts at the shuffle's sixteenths, also where the file has no transient", async () => {
        const straight = await render({mode: "grain", offset: null}, 1)
        const grooved = await render({mode: "grain", offset: null, shuffle: true}, 1)
        // the first sixteenth plays longer than its segment, the voice ends before the shuffled second one starts
        const quiet = (samples: Float32Array, from: int, to: int) => {
            for (let index = from; index < to - 100; index += 20) {
                if (peak(samples.subarray(index, index + 100)) < 0.005) {return true}
            }
            return false
        }
        expect(quiet(straight, 1000, 12000), "straight plays the tone through").toBe(false)
        expect(quiet(grooved, 5800, 7400), "the cut at the first sixteenth").toBe(true)
        expect(peak(grooved.subarray(7400, 9000))).toBeGreaterThan(0.1)
    }, 300000)
    it("a No Sync region ignores a groove", async () => {
        const straight = await render({mode: "no-sync", offset: null}, 1)
        const grooved = await render({mode: "no-sync", offset: 240}, 1)
        expect(peak(straight)).toBeGreaterThan(0.01)
        expect(grooved.every((value, index) => value === straight[index])).toBe(true)
    }, 300000)
})
