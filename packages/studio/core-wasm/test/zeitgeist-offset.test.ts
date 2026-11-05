// An offset groove behind a Zeitgeist in the FULL engine: every note must sound exactly once, moved by the
// offset, across block edges, at the playback start and across loop wraps. The Apparat writes an impulse of
// 1.0 at each note-on sample, so every onset and every doubled or missing note is countable.
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveOffsetBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
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

// the same, plus an impulse in the right channel at each note-off
const LENGTH_CODE = `class Processor {
    pending = 0
    released = 0
    noteOn(pitch, velocity, cent, id) { this.pending++ }
    noteOff(id) { this.released++ }
    process(output, block) {
        if (this.pending > 0) { output[0][block.s0] += this.pending; this.pending = 0 }
        if (this.released > 0) { output[1][block.s0] += this.released; this.released = 0 }
    }
}`

type Setup = { offset: int, loop?: [int, int], bars: int }

// 16ths, every odd bar half a 16th later, so a note leaking in from beyond the loop shows
const notePositions = (bars: int): ReadonlyArray<int> => {
    const positions: Array<int> = []
    for (let bar = 0; bar < bars; bar++) {
        for (let position = bar * BAR + (bar % 2) * STEP / 2; position < (bar + 1) * BAR; position += STEP) {
            positions.push(position)
        }
    }
    return positions
}

// the notes as played: straight up to the loop start, then the loop over and over, each moved by the offset
const unrolled = (bars: int, [loopFrom, loopTo]: [int, int], offset: int, span: int): ReadonlyArray<number> => {
    const positions = notePositions(bars)
    const expected: Array<number> = []
    const keep = (at: number) => {if (at >= 0 && at < span) {expected.push(at)}}
    positions.filter(position => position < loopFrom).forEach(position => keep(position + offset))
    for (let pass = 0; loopFrom + pass * (loopTo - loopFrom) < span + Math.abs(offset); pass++) {
        positions.filter(position => position >= loopFrom && position < loopTo)
            .forEach(position => keep(position + pass * (loopTo - loopFrom) + offset))
    }
    return expected
}

const build = async ({offset, loop, bars}: Setup, code: string) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    if (loop !== undefined) {
        timelineBox.loopArea.enabled.setValue(true)
        timelineBox.loopArea.from.setValue(loop[0])
        timelineBox.loopArea.to.setValue(loop[1])
    } else {
        timelineBox.loopArea.enabled.setValue(false)
    }
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + code)
    })
    const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.grooves)
        box.index.setValue(1)
        box.offset.setValue(offset)
    })
    ZeitgeistDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.groove.refer(groove)
        box.index.setValue(0)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (const position of notePositions(bars)) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(position)
            box.duration.setValue(STEP / 2)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(bars * BAR)
        box.loopDuration.setValue(bars * BAR)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, code))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    // calls back with both channels of every quantum and its first sample
    const play = (pulses: int, quantum: (left: Float32Array, right: Float32Array, start: int) => void): void => {
        const quanta = Math.ceil(pulses * SAMPLES_PER_PULSE / half)
        for (let index = 0; index < quanta; index++) {
            engine.render()
            quantum(new Float32Array(memory.buffer, engine.output_ptr(), half),
                new Float32Array(memory.buffer, engine.output_ptr() + half * 4, half), index * half)
        }
        sync.close()
    }
    return {play}
}

const render = async (setup: Setup, pulses: int): Promise<ReadonlyArray<int>> => {
    const {play} = await build(setup, CODE)
    const onsets: Array<int> = []
    play(pulses, (left, _right, start) => left.forEach((value, index) => {
        for (let count = 0; count < Math.round(value); count++) {onsets.push(start + index)}
    }))
    return onsets.filter(sample => sample < pulses * SAMPLES_PER_PULSE)
}

const expectOnsets = (actual: ReadonlyArray<int>, expected: ReadonlyArray<number>, what: string): void => {
    const wanted = expected.map(pulse => Math.round(pulse * SAMPLES_PER_PULSE)).sort((a, b) => a - b)
    expect(actual.length, `${what}: ${actual.length} onsets, expected ${wanted.length}`).toBe(wanted.length)
    actual.forEach((sample, index) =>
        expect(Math.abs(sample - wanted[index]), `${what}: onset ${index} at ${sample} vs ${wanted[index]}`)
            .toBeLessThanOrEqual(1))
}

// offsets at the limits, one tick, and ones that put notes exactly onto block edges (128 samples = 5.12 pulses)
const Offsets = [-480, -448, -240, -1, 0, 1, 32, 240, 479, 480]

describe("an offset groove in the engine", () => {
    it("plays every note once, moved by the offset, from the start without a loop", async () => {
        for (const offset of Offsets) {
            const span = 2 * BAR
            const onsets = await render({offset, bars: 2}, span)
            const expected: Array<number> = []
            for (const position of notePositions(2)) {
                const moved = position + offset
                if (moved >= 0 && moved < span) {expected.push(moved)}
            }
            expectOnsets(onsets, expected, `offset ${offset}`)
        }
    }, 300000)
    it("plays every note of the loop once per pass, wrapped around the loop", async () => {
        for (const offset of Offsets) {
            const passes = 3
            const onsets = await render({offset, loop: [0, BAR], bars: 2}, passes * BAR)
            const expected: Array<number> = []
            for (let pass = 0; pass <= passes; pass++) {
                // a note moved past the loop end plays at the start of the next pass, one moved before the
                // loop start at the end of the previous pass, nothing before the playback start
                for (let position = 0; position < BAR; position += STEP) {
                    const at = pass * BAR + position + offset
                    if (at >= 0 && at < passes * BAR) {expected.push(at)}
                }
            }
            expectOnsets(onsets, expected, `loop offset ${offset}`)
        }
    }, 300000)
    it("enters a loop that starts later straight and wraps it from then on", async () => {
        for (const offset of Offsets) {
            const loop: [int, int] = [BAR, 2 * BAR]
            const onsets = await render({offset, loop, bars: 3}, 4 * BAR)
            expectOnsets(onsets, unrolled(3, loop, offset, 4 * BAR), `late loop offset ${offset}`)
        }
    }, 300000)
    it("keeps every note's length across the loop wrap", async () => {
        for (const offset of Offsets) {
            const {play} = await build({offset, loop: [0, BAR], bars: 2}, LENGTH_CODE)
            const ons: Array<int> = [], offs: Array<int> = []
            play(3 * BAR, (left, right, start) => left.forEach((value, index) => {
                for (let count = 0; count < Math.round(value); count++) {ons.push(start + index)}
                for (let count = 0; count < Math.round(right[index]); count++) {offs.push(start + index)}
            }))
            // every note but the last is released half a 16th after it started
            ons.slice(0, -1).forEach((on, index) => expect(Math.abs(offs[index] - on - STEP / 2 * SAMPLES_PER_PULSE),
                `offset ${offset}: note ${index} at ${on / SAMPLES_PER_PULSE} lasts ${(offs[index] - on) / SAMPLES_PER_PULSE}`)
                .toBeLessThanOrEqual(1))
        }
    }, 300000)
    it("wraps a loop shorter than the offset more than once", async () => {
        for (const offset of Offsets) {
            const loop: [int, int] = [BAR, BAR + STEP]
            const onsets = await render({offset, loop, bars: 3}, 2 * BAR)
            expectOnsets(onsets, unrolled(3, loop, offset, 2 * BAR), `short loop offset ${offset}`)
        }
    }, 300000)
})
