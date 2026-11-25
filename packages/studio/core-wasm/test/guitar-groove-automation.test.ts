// The Guitar through an offset groove with its chord or slot automated, a chord track starting late as well.
// A switch drawn on a grid position belongs to the stroke of that grid position, wherever the groove moves the stroke.
// One stroke per bar, silence before the switch, so the first sounding sample tells which stroke took the new value.
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {Guitar, Interpolation} from "@opendaw/lib-dsp"
import {
    AudioUnitBox, ChordEventBox, GrooveOffsetBox, GuitarDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {GuitarPatterns, InterpolationFieldAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_PULSE = 25 // 48k, 120 bpm, 960 per quarter
const BAR = 3840
const SIXTEENTH = 240
const SWITCH = 2 * BAR

type Scene = {
    offset: int
    // the stroke's step within the bar
    step: int
    switching: "chord" | "slot" | "chord-track"
}

const firstSound = async ({offset, step, switching}: Scene, bars: int): Promise<number> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.grooves)
        box.index.setValue(1)
        box.offset.setValue(offset)
    })
    const steps = Array.from({length: 16}, (_, index) => GuitarPatterns.parse(index === step ? "D" : ".")[0])
    const guitar = GuitarDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.groove.refer(groove)
        box.shapes.getField(0).setValue(Guitar.packShape([-1, 3, 2, 0, 1, 0]))
        GuitarPatterns.write(GuitarPatterns.slot(box, 0), switching === "slot" ? [] : steps, 16)
        GuitarPatterns.write(GuitarPatterns.slot(box, 1), steps, 16)
        box.chord.setValue(switching === "chord" ? 0 : 1)
    })
    if (switching === "chord-track") {
        guitar.chord.setValue(0)
        ChordEventBox.create(source, UUID.generate(), box => {
            box.track.refer(timelineBox.chordTrack.events)
            box.position.setValue(SWITCH)
            box.duration.setValue(4 * BAR)
            box.degree.setValue(1)
        })
    } else {
        const lane = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(switching === "chord" ? guitar.chord : guitar.slot)
            box.tracks.refer(unit.tracks)
        })
        const curve = ValueEventCollectionBox.create(source, UUID.generate())
        const event = (position: number, value: number, order: number) =>
            ValueEventBox.create(source, UUID.generate(), box => {
                box.position.setValue(position)
                box.value.setValue(value)
                box.index.setValue(order)
                box.events.refer(curve.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
        event(0, 0.0, 0)
        event(SWITCH, switching === "chord" ? 1 / 16 : 1 / 15, 1)
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(lane.regions)
            box.events.refer(curve.owners)
            box.position.setValue(0)
            box.duration.setValue(bars * BAR)
            box.loopDuration.setValue(bars * BAR)
        })
    }
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    const quanta = Math.ceil(bars * BAR * SAMPLES_PER_PULSE / half)
    let found = -1
    for (let quantum = 0; quantum < quanta && found < 0; quantum++) {
        engine.render()
        const index = new Float32Array(memory.buffer, engine.output_ptr(), half).findIndex(value => Math.abs(value) > 1.0e-4)
        if (index >= 0) {found = (quantum * half + index) / SAMPLES_PER_PULSE}
    }
    sync.close()
    return found
}

// the strum and the attack take a few pulses, a missed switch is a whole bar off
const expectNear = (actual: number, expected: number, what: string) =>
    expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(SIXTEENTH / 2)

describe("Guitar automation under a groove", () => {
    for (const switching of ["chord", "slot", "chord-track"] as const) {
        it(`a ${switching} switch reaches the stroke the groove pulls before it`, async () => {
            expectNear(await firstSound({offset: -SIXTEENTH, step: 0, switching}, 4), SWITCH - SIXTEENTH, switching)
        }, 120000)
        it(`a ${switching} switch skips the stroke the groove pushes past it`, async () => {
            const last = 15 * SIXTEENTH
            expectNear(await firstSound({offset: 2 * SIXTEENTH, step: 15, switching}, 4), SWITCH + last + 2 * SIXTEENTH, switching)
        }, 120000)
        it(`a ${switching} switch sounds on time without a groove`, async () => {
            expectNear(await firstSound({offset: 0, step: 0, switching}, 4), SWITCH, switching)
        }, 120000)
    }
})
