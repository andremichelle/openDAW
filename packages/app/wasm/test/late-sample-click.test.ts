// Reproduces the "play starts with a click" report at its root: an audio region at position 0 whose sample is
// NOT ready when play starts (the browser decodes samples asynchronously, so the first blocks render silence).
// When the sample lands mid-playback, `audio_region_player.rs` seats a fresh native cursor at the CURRENT
// transport position (mid-waveform, line 212) at full gain, with the start-edge declick inapplicable (it only
// fires for waveform_offset > 0 near the region start) -> a jump from silence to a mid-waveform sample = a click.
// Baseline (sample ready BEFORE play) reads from frame 0 (~0) -> smooth. The delta between the two is the bug.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TimeBase} from "@opendaw/lib-dsp"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const buildProject = () => {
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
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0)
        box.timeBase.setValue(TimeBase.Seconds)
        box.duration.setValue(1.0)
        box.loopDuration.setValue(1.0)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(collection.owners)
    })
    source.endTransaction()
    return source
}

// The largest inter-sample jump in the reconstructed L channel (each quantum is planar [L(half)|R(half)]).
const maxLeftJump = (output: Float32Array, len: number, quanta: number): {jump: number, at: number} => {
    const half = len >>> 1
    const left = new Float32Array(quanta * half)
    for (let q = 0; q < quanta; q++) {left.set(output.subarray(q * len, q * len + half), q * half)}
    let jump = 0, at = -1
    for (let i = 1; i < left.length; i++) {
        const delta = Math.abs(left[i] - left[i - 1])
        if (delta > jump) {jump = delta; at = i}
    }
    return {jump, at}
}

describe("late sample click", () => {
    const QUANTA = 24
    const DELAY_BLOCKS = 5 // the sample only becomes ready after this many blocks of play

    const run = async (readyBeforePlay: boolean): Promise<Float32Array> => {
        const source = buildProject()
        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        if (readyBeforePlay) {expect(drainSamples()).toBeGreaterThan(0)}
        const len = engine.output_len() >>> 0
        engine.stop(); engine.play()
        const output = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            if (!readyBeforePlay && q === DELAY_BLOCKS) {expect(drainSamples()).toBeGreaterThan(0)}
            engine.render()
            output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        return output
    }

    it("a sample ready BEFORE play reads from frame 0 -> smooth onset (no click)", async () => {
        const {engine} = await loadFullEngine()
        const len = engine.output_len() >>> 0
        const output = await run(true)
        const {jump, at} = maxLeftJump(output, len, QUANTA)
        console.log("BASELINE (ready before play) max L jump", jump.toFixed(5), "@sample", at)
        expect(jump).toBeLessThan(0.05) // smooth
    }, 60000)

    it("a sample ready AFTER play seats mid-waveform at full gain -> a click at the arrival block", async () => {
        const {engine} = await loadFullEngine()
        const len = engine.output_len() >>> 0
        const half = len >>> 1
        const output = await run(false)
        const {jump, at} = maxLeftJump(output, len, QUANTA)
        console.log("LATE (ready after", DELAY_BLOCKS, "blocks) max L jump", jump.toFixed(5),
            "@sample", at, "(block", Math.floor(at / half), ")")
        // The bug: a hard step from silence to a mid-waveform sample lands right at the arrival block.
        expect(jump).toBeGreaterThan(0.05)
        expect(Math.floor(at / half)).toBe(DELAY_BLOCKS)
    }, 60000)
})
