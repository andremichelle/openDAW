// Regions with a groove in the FULL engine. The groove runs on from where the region's loop starts, across its
// loop cycles. A note region moves its notes, an automation region its curve. The Apparat writes an impulse of 1.0 at each note-on sample.
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveOffsetBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox,
    ValueEventBox, ValueEventCollectionBox, ValueRegionBox
} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_PULSE = 25 // 48k, 120 bpm, 960 per quarter
const STEP = 240
const BAR = 3840
const CODE = `class Processor {
    pending = 0
    noteOn(pitch, velocity, cent, id) { this.pending++ }
    noteOff(id) {}
    process(output, block) {
        if (this.pending > 0) { output[0][block.s0] += this.pending; this.pending = 0 }
    }
}`

type Setup = {
    offset: int
    notes?: { grooved: boolean, position: int, loopOffset: int, loopDuration: int, duration: int }
    // the unit is muted until `at`, the region carrying the switch grooved or not
    unmute?: { at: int, grooved: boolean }
}

const render = async ({offset, notes, unmute}: Setup, pulses: int): Promise<ReadonlyArray<number>> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + CODE)
    })
    const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.grooves)
        box.index.setValue(1)
        box.offset.setValue(offset)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (let position = 0; position < BAR; position += STEP) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(position)
            box.duration.setValue(STEP / 2)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
        })
    }
    const region = notes ?? {grooved: false, position: 0, loopOffset: 0, loopDuration: BAR, duration: 4 * BAR}
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(region.position)
        box.duration.setValue(region.duration)
        box.loopOffset.setValue(region.loopOffset)
        box.loopDuration.setValue(region.loopDuration)
        if (region.grooved) {box.groove.refer(groove)}
    })
    if (unmute !== undefined) {
        const lane = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(unit.mute)
            box.tracks.refer(unit.tracks)
        })
        const curve = ValueEventCollectionBox.create(source, UUID.generate())
        const event = (position: number, value: number, order: number) =>
            ValueEventBox.create(source, UUID.generate(), box => {
                box.position.setValue(position)
                box.value.setValue(value)
                box.index.setValue(order)
                box.slope.setValue(NaN)
                box.events.refer(curve.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
        event(0, 1.0, 0)
        event(unmute.at, 0.0, 1)
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(lane.regions)
            box.events.refer(curve.owners)
            box.position.setValue(0)
            box.duration.setValue(4 * BAR)
            box.loopDuration.setValue(4 * BAR)
            if (unmute.grooved) {box.groove.refer(groove)}
        })
    }
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, CODE))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    const onsets: Array<number> = []
    for (let quantum = 0; quantum < Math.ceil(pulses * SAMPLES_PER_PULSE / half); quantum++) {
        engine.render()
        new Float32Array(memory.buffer, engine.output_ptr(), half).forEach((value, index) => {
            if (Math.abs(value) > 0.5) {onsets.push((quantum * half + index) / SAMPLES_PER_PULSE)}
        })
    }
    sync.close()
    return onsets.filter(pulse => pulse < pulses)
}

const near = (actual: ReadonlyArray<number>, expected: ReadonlyArray<number>, what: string) => {
    expect(actual.length, `${what}: ${actual.join(" ")}`).toBe(expected.length)
    actual.forEach((pulse, index) => expect(Math.abs(pulse - expected[index]), `${what}: ${pulse} vs ${expected[index]}`)
        .toBeLessThanOrEqual(0.05))
}

describe("a region with a groove", () => {
    it("moves the notes of every loop cycle, across the cycle edge, not past the region end", async () => {
        for (const offset of [-240, 120, 240]) {
            const onsets = await render({offset, notes: {grooved: true, position: 0, loopOffset: 0, loopDuration: BAR, duration: 2 * BAR}}, 3 * BAR)
            const expected: Array<number> = []
            for (const cycle of [0, BAR]) {
                for (let position = 0; position < BAR; position += STEP) {
                    const moved = cycle + position + offset
                    if (moved >= 0 && moved < 2 * BAR) {expected.push(moved)}
                }
            }
            near(onsets, expected.sort((a, b) => a - b), `offset ${offset}`)
        }
    }, 120000)

    it("starts the groove where the region's loop starts", async () => {
        // a region at bar 2 showing its content from the second beat: the cycle starts a beat before the region
        const onsets = await render({offset: 120, notes: {grooved: true, position: BAR, loopOffset: 960, loopDuration: BAR, duration: 3 * 960}}, 2 * BAR)
        const expected: Array<number> = []
        for (let position = 960; position < BAR; position += STEP) {
            if (position + 120 < BAR) {expected.push(BAR - 960 + position + 120)}
        }
        near(onsets, expected, "loop offset")
    }, 120000)

    it("plays an ungrooved region straight", async () => {
        const onsets = await render({offset: 240, notes: {grooved: false, position: 0, loopOffset: 0, loopDuration: BAR, duration: BAR}}, BAR)
        near(onsets, Array.from({length: 16}, (_, index) => index * STEP), "straight")
    }, 120000)

    it("moves an automation region's curve", async () => {
        // muted until just before beat 3, the groove moves the switch an eighth later
        const straight = await render({offset: 480, unmute: {at: 1800, grooved: false}}, BAR)
        const grooved = await render({offset: 480, unmute: {at: 1800, grooved: true}}, BAR)
        expect(straight[0]).toBe(1920)
        expect(grooved[0]).toBe(2400)
    }, 120000)
})
