// A unit-level ARP in front of a Playfield. The arp is ONE stateful instance, and every pad pulls it again
// over the same window. Pad A (note 60, hard left) must sound sample-identical whether or not pad B (note 64,
// hard right) exists: a second pad pulling the shared arp must not change what the first pad receives.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox, AudioFileBox, AudioUnitBox, GrooveShuffleBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox,
    PlayfieldDeviceBox, PlayfieldSampleBox, TrackBox, VelocityDeviceBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type UnitFx = "none" | "arp" | "stateless"

const renderLeft = async (pads: ReadonlyArray<{note: number, panning: number}>, fx: UnitFx): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const playfield = PlayfieldDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    pads.forEach(({note, panning}) => {
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(1.0)
            box.fileName.setValue("synthetic")
        })
        PlayfieldSampleBox.create(source, UUID.generate(), box => {
            box.device.refer(playfield.samples)
            box.file.refer(file)
            box.index.setValue(note)
            box.panning.setValue(panning)
            box.gate.setValue(1)
        })
    })
    if (fx === "arp") {
        ArpeggioDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.rateIndex.setValue(9)
            box.gate.setValue(0.5)
        })
    } else if (fx === "stateless") {
        VelocityDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.randomAmount.setValue(0.8)
            box.randomSeed.setValue(1234)
        })
        const groove = GrooveShuffleBox.create(source, UUID.generate(), box => {
            box.label.setValue("Shuffle")
            box.duration.setValue(480)
            box.amount.setValue(0.65)
        })
        ZeitgeistDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.groove.refer(groove)
            box.index.setValue(1)
        })
    }
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    const notes = fx === "stateless"
        ? Array.from({length: 16}, (_, step) => ({position: step * 240, duration: 120, pitch: step % 3 === 0 ? 64 : 60}))
        : [60, 64].map(pitch => ({position: 0, duration: 200_000, pitch}))
    for (const {position, duration, pitch} of notes) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    source.endTransaction()
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    const quanta = Math.ceil(2 * 48000 / half)
    engine.stop(); engine.play()
    const left = new Float32Array(quanta * half)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
    }
    sync.close()
    return left
}

const difference = (a: Float32Array, b: Float32Array): number =>
    a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index])), 0)

const peak = (channel: Float32Array): number => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0)

const PAD_A = {note: 60, panning: -1.0}
const PAD_B = {note: 64, panning: 1.0}

describe("playfield behind a unit-level arp", () => {
    it("control: without an arp a second pad does not change the first", async () => {
        const alone = await renderLeft([PAD_A], "none")
        const paired = await renderLeft([PAD_A, PAD_B], "none")
        expect(peak(alone)).toBeGreaterThan(0.1)
        expect(difference(alone, paired)).toBeLessThan(1e-6)
    }, 60000)

    it("stateless unit-level effects (Velocity, Zeitgeist): a second pad does not change the first", async () => {
        const alone = await renderLeft([PAD_A], "stateless")
        const paired = await renderLeft([PAD_A, PAD_B], "stateless")
        const checksum = paired.reduce((sum, value, index) => sum + value * ((index % 997) + 1), 0)
        console.log(`stateless checksum=${checksum} peak=${peak(paired)}`)
        expect(peak(alone)).toBeGreaterThan(0.1)
        expect(difference(alone, paired)).toBeLessThan(1e-6)
    }, 60000)

    it("with a unit-level arp a second pad does not change the first", async () => {
        const alone = await renderLeft([PAD_A], "arp")
        const paired = await renderLeft([PAD_A, PAD_B], "arp")
        console.log(`peak alone=${peak(alone)} paired=${peak(paired)} difference=${difference(alone, paired)}`)
        expect(peak(alone)).toBeGreaterThan(0.1)
        expect(difference(alone, paired)).toBeLessThan(1e-6)
    }, 60000)
})
