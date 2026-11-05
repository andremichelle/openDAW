// An offset groove behind a Zeitgeist in the FULL engine: every note sounds once, moved by the offset, across
// block edges and at the playback start. A loop wrap is a jump: each pass plays the loop's notes the groove keeps
// inside the loop, nothing from beyond it. The Apparat writes an impulse of 1.0 at each note-on sample, so every
// onset and every doubled or missing note is countable.
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveFunctionBox, GrooveOffsetBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox,
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

// a cell groove instead of the offset: a power curve over `duration` at `amount`
type Setup = { offset: int, loop?: [int, int], bars: int, power?: {duration: int, amount: number} }

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

// the notes as played: up to the loop end every note moved before it, then each pass the loop's notes the
// offset keeps inside the loop
const jumped = (bars: int, [loopFrom, loopTo]: [int, int], offset: int, span: int): ReadonlyArray<number> => {
    const positions = notePositions(bars)
    const length = loopTo - loopFrom
    const expected: Array<number> = []
    const keep = (at: number) => {if (at >= 0 && at < span) {expected.push(at)}}
    positions.filter(position => position < loopTo && position + offset < loopTo).forEach(position => keep(position + offset))
    for (let pass = 1; loopFrom + pass * length < span; pass++) {
        positions.filter(position => position >= loopFrom && position < loopTo)
            .map(position => position + offset)
            .filter(at => at >= loopFrom && at < loopTo)
            .forEach(at => keep(at + pass * length))
    }
    return expected
}

const build = async ({offset, loop, bars, power}: Setup, code: string) => {
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
    const groove = power === undefined
        ? GrooveOffsetBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.offset.setValue(offset)
        })
        : GrooveFunctionBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.amount.setValue(power.amount)
            box.duration.setValue(power.duration)
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
    it("plays the loop's notes the offset keeps inside the loop on every pass", async () => {
        for (const offset of Offsets) {
            const loop: [int, int] = [0, BAR]
            const onsets = await render({offset, loop, bars: 2}, 3 * BAR)
            expectOnsets(onsets, jumped(2, loop, offset, 3 * BAR), `loop offset ${offset}`)
        }
    }, 300000)
    it("enters a loop that starts later straight and jumps from then on", async () => {
        for (const offset of Offsets) {
            const loop: [int, int] = [BAR, 2 * BAR]
            const onsets = await render({offset, loop, bars: 3}, 4 * BAR)
            expectOnsets(onsets, jumped(3, loop, offset, 4 * BAR), `late loop offset ${offset}`)
        }
    }, 300000)
    it("keeps every note's length, a note sounding at the wrap ends there", async () => {
        for (const offset of Offsets) {
            const {play} = await build({offset, loop: [0, BAR], bars: 2}, LENGTH_CODE)
            const ons: Array<int> = [], offs: Array<int> = []
            play(3 * BAR, (left, right, start) => left.forEach((value, index) => {
                for (let count = 0; count < Math.round(value); count++) {ons.push(start + index)}
                for (let count = 0; count < Math.round(right[index]); count++) {offs.push(start + index)}
            }))
            // every note is released once, half a 16th after it started or within the first block after the wrap
            const length = STEP / 2 * SAMPLES_PER_PULSE, wrap = BAR * SAMPLES_PER_PULSE, block = 128
            expect(offs.length, `offset ${offset}: releases`).toBeGreaterThanOrEqual(ons.length - 1)
            ons.slice(0, -1).forEach((on, index) => {
                const lasts = offs[index] - on, nextWrap = (Math.floor(on / wrap) + 1) * wrap
                const what = `offset ${offset}: note ${index} at ${on / SAMPLES_PER_PULSE} lasts ${lasts / SAMPLES_PER_PULSE}`
                if (on + length < nextWrap) {expect(Math.abs(lasts - length), what).toBeLessThanOrEqual(1)}
                else {expect(offs[index] >= nextWrap - 1 && offs[index] <= nextWrap + block, what).toBe(true)}
            })
        }
    }, 300000)
    it("repeats a loop whose cell is longer than the loop pass by pass, without piling notes up", async () => {
        // the PEAK project: a power curve over 8 bars at 92% on a 4 bar loop pushes the second half past the loop end,
        // at 8% pulls notes from beyond it
        for (const amount of [0.92, 0.08]) {
            const loopLength = 4 * BAR, passes = 4
            const onsets = await render({offset: 0, loop: [0, loopLength], bars: 4, power: {duration: 8 * BAR, amount}},
                passes * loopLength)
            // the windows start a little early, the engine's loop wrap drifts by a sample per pass
            const start = (index: int) => index * loopLength * SAMPLES_PER_PULSE - 64
            const pass = (index: int) => onsets
                .filter(sample => sample >= start(index) && sample < start(index + 1))
                .map(sample => sample - index * loopLength * SAMPLES_PER_PULSE)
            expect(new Set(onsets).size, `amount ${amount}: notes sharing a sample`).toBe(onsets.length)
            // every pass sounds like the one before
            expect(pass(0).length, `amount ${amount}: notes in the first pass`).toBeGreaterThan(0)
            for (let index = 1; index < passes; index++) {
                const [previous, current] = [pass(index - 1), pass(index)]
                expect(current.length, `amount ${amount}: pass ${index} has ${current.length} notes`).toBe(previous.length)
                current.forEach((sample, note) => expect(Math.abs(sample - previous[note]),
                    `amount ${amount}: pass ${index} note ${note}`).toBeLessThanOrEqual(1))
            }
        }
    }, 300000)
    it("plays a loop shorter than the offset", async () => {
        for (const offset of Offsets) {
            const loop: [int, int] = [BAR, BAR + STEP]
            const onsets = await render({offset, loop, bars: 3}, 2 * BAR)
            expectOnsets(onsets, jumped(3, loop, offset, 2 * BAR), `short loop offset ${offset}`)
        }
    }, 300000)
})
