// The Sampler end to end through the real engine: zones, groups and modulation slots are child boxes the device
// only sees as observed tables, so this is the test that a project's boxes reach the voices, on load and on
// every later edit. Each sample is a constant, so the output level says which zone played.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    AudioFileBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SamplerDeviceBox,
    SamplerGroupBox, SamplerModulationBox, SamplerZoneBox, TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const FRAMES = 48000
const BEAT = 1920 // the notes are a second apart at 120 bpm, each half a second long
const QUANTA_PER_BEAT = 375 // exactly one second of 128 frame quanta

type Note = {beat: number, key: number, velocity?: number}

const build = (notes: ReadonlyArray<Note>) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const sampler = SamplerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.volume.setValue(0.0)
        box.ampEnvelope.attack.setValue(0.001)
        box.ampEnvelope.release.setValue(0.005)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    notes.forEach(({beat, key, velocity}) => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(beat * BEAT)
        box.duration.setValue(BEAT / 2)
        box.pitch.setValue(key)
        box.velocity.setValue(velocity ?? 1.0)
        box.cent.setValue(0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(64 * BEAT)
        box.loopDuration.setValue(64 * BEAT)
    })
    source.endTransaction()
    return {source, sampler}
}

const createFile = (source: BoxGraph, name: string): AudioFileBox => AudioFileBox.create(source, UUID.generate(), box => {
    box.startInSeconds.setValue(0.0)
    box.endInSeconds.setValue(1.0)
    box.fileName.setValue(name)
})

const createGroup = (source: BoxGraph, sampler: SamplerDeviceBox, index: number): SamplerGroupBox =>
    SamplerGroupBox.create(source, UUID.generate(), box => {
        box.device.refer(sampler.groups)
        box.index.setValue(index)
    })

const createZone = (source: BoxGraph, sampler: SamplerDeviceBox, group: SamplerGroupBox, file: AudioFileBox,
                    keyLow: number, keyHigh: number): SamplerZoneBox => SamplerZoneBox.create(source, UUID.generate(), box => {
    box.device.refer(sampler.zones)
    box.group.refer(group.zones)
    box.file.refer(file)
    box.keyLow.setValue(keyLow)
    box.keyHigh.setValue(keyHigh)
    box.keyTrack.setValue(0.0)
})

const boot = async (source: BoxGraph, levels: Array<[AudioFileBox, number]>) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    // answer every pending sample request with the constant of its file
    const serveSamples = (): number => {
        let served = 0
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(memory.buffer, requestPtr, 16).slice() as UUID.Bytes
            const level = levels.find(([file]) => UUID.equals(file.address.uuid, uuid))?.[1] ?? 0.0
            const pointer = engine.sample_allocate(handle, FRAMES * 4)
            new Float32Array(memory.buffer, pointer, FRAMES).fill(level)
            engine.sample_set_ready(handle, FRAMES, 1, 48000)
            served++
        }
        return served
    }
    await sync.settle()
    engine.bind()
    await sync.settle()
    serveSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop()
    engine.play()
    // the peak of the next beat's worth of output
    const beat = (): number => {
        let peak = 0.0
        for (let quantum = 0; quantum < QUANTA_PER_BEAT; quantum++) {
            engine.render()
            const output = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len())
            for (let index = 0; index < output.length; index++) {
                expect(Number.isFinite(output[index])).toBe(true)
                peak = Math.max(peak, Math.abs(output[index]))
            }
        }
        return peak
    }
    const edit = async (procedure: () => void): Promise<void> => {
        source.beginTransaction()
        procedure()
        source.endTransaction()
        await sync.settle()
        serveSamples()
        await sync.settle()
    }
    return {beat, edit, serveSamples}
}

describe("sampler", () => {
    it("plays the zone of the key that is played, and nothing where no zone is", async () => {
        const {source, sampler} = build([{beat: 0, key: 60}, {beat: 1, key: 62}, {beat: 2, key: 64}])
        source.beginTransaction()
        const quiet = createFile(source, "quiet")
        const loud = createFile(source, "loud")
        const group = createGroup(source, sampler, 0)
        createZone(source, sampler, group, quiet, 60, 60)
        createZone(source, sampler, group, loud, 62, 62)
        source.endTransaction()
        const {beat} = await boot(source, [[quiet, 0.2], [loud, 0.4]])
        const first = beat()
        const second = beat()
        const third = beat()
        expect(first).toBeGreaterThan(0.05)
        expect(second / first).toBeCloseTo(2.0, 2)
        expect(third).toBeLessThan(first * 0.05)
    }, 60000)

    it("follows edits of a zone while the project plays", async () => {
        const {source, sampler} = build(Array.from({length: 8}, (_, index) => ({beat: index, key: 64})))
        source.beginTransaction()
        const file = createFile(source, "tone")
        const group = createGroup(source, sampler, 0)
        const zone = createZone(source, sampler, group, file, 60, 60)
        source.endTransaction()
        const {beat, edit} = await boot(source, [[file, 0.4]])
        expect(beat(), "key 64 is outside the zone").toBeLessThan(0.001)
        await edit(() => zone.keyHigh.setValue(64))
        const inside = beat()
        expect(inside, "the widened zone answers").toBeGreaterThan(0.05)
        await edit(() => zone.gain.setValue(-6.0))
        expect(beat() / inside, "a gain edit reaches the next note").toBeCloseTo(Math.pow(10.0, -6.0 / 20.0), 2)
        await edit(() => zone.keyHigh.setValue(63))
        beat()
        expect(beat(), "narrowed again, silent again").toBeLessThan(0.001)
    }, 60000)

    it("follows zones that are added, repointed to another sample and deleted", async () => {
        const {source, sampler} = build(Array.from({length: 10}, (_, index) => ({beat: index, key: 60})))
        source.beginTransaction()
        const group = createGroup(source, sampler, 0)
        source.endTransaction()
        const levels: Array<[AudioFileBox, number]> = []
        const {beat, edit} = await boot(source, levels)
        expect(beat(), "no zone yet").toBeLessThan(0.001)
        let zone: SamplerZoneBox = undefined as never
        let quiet: AudioFileBox = undefined as never
        let loud: AudioFileBox = undefined as never
        await edit(() => {
            quiet = createFile(source, "quiet")
            levels.push([quiet, 0.2])
            zone = createZone(source, sampler, group, quiet, 0, 127)
        })
        const added = beat()
        expect(added, "the added zone plays, its sample was requested and loaded").toBeGreaterThan(0.05)
        await edit(() => {
            loud = createFile(source, "loud")
            levels.push([loud, 0.4])
            zone.file.refer(loud)
            quiet.delete()
        })
        expect(beat() / added, "the repointed zone plays the other sample").toBeCloseTo(2.0, 2)
        await edit(() => {
            zone.delete()
            loud.delete()
        })
        beat()
        expect(beat(), "the deleted zone is gone").toBeLessThan(0.001)
    }, 60000)

    it("takes the round robin from the zone's group, and follows a move to another group", async () => {
        const {source, sampler} = build(Array.from({length: 10}, (_, index) => ({beat: index, key: 60})))
        source.beginTransaction()
        const quiet = createFile(source, "quiet")
        const loud = createFile(source, "loud")
        const cycling = createGroup(source, sampler, 0)
        cycling.roundRobin.setValue(1)
        const layered = createGroup(source, sampler, 1)
        const first = createZone(source, sampler, cycling, quiet, 60, 60)
        first.sequence.setValue(1)
        const second = createZone(source, sampler, cycling, loud, 60, 60)
        second.sequence.setValue(2)
        source.endTransaction()
        const {beat, edit} = await boot(source, [[quiet, 0.2], [loud, 0.4]])
        const one = beat()
        const two = beat()
        const three = beat()
        expect(two / one, "the round robins take turns").toBeCloseTo(2.0, 2)
        expect(three / one).toBeCloseTo(1.0, 2)
        await edit(() => cycling.roundRobin.setValue(0))
        expect(beat() / one, "without round robin both zones sound").toBeCloseTo(3.0, 2)
        await edit(() => {
            cycling.roundRobin.setValue(1)
            second.group.refer(layered.zones)
        })
        expect(beat() / one, "in different groups they are no round robins of each other").toBeCloseTo(3.0, 2)
    }, 60000)

    it("applies modulation slots as they are added, edited and removed", async () => {
        const {source, sampler} = build(Array.from({length: 10}, (_, index) => ({beat: index, key: 60, velocity: 0.5})))
        source.beginTransaction()
        const file = createFile(source, "tone")
        const group = createGroup(source, sampler, 0)
        createZone(source, sampler, group, file, 0, 127)
        source.endTransaction()
        const {beat, edit} = await boot(source, [[file, 0.4]])
        const plain = beat()
        expect(plain).toBeGreaterThan(0.05)
        let slot: SamplerModulationBox = undefined as never
        await edit(() => slot = SamplerModulationBox.create(source, UUID.generate(), box => {
            box.device.refer(sampler.modulations)
            box.source.setValue(4)
            box.target.setValue(3)
            box.amount.setValue(1.0)
        }))
        expect(beat() / plain, "velocity 0.5 at full amount: a quarter of the level").toBeCloseTo(0.25, 2)
        await edit(() => slot.amount.setValue(0.5))
        expect(beat() / plain).toBeCloseTo(0.75 * 0.75, 2)
        await edit(() => slot.delete())
        expect(beat() / plain, "the slot is gone").toBeCloseTo(1.0, 2)
    }, 60000)

    it("stays silent while a zone's sample has not arrived, then plays it", async () => {
        const {source, sampler} = build(Array.from({length: 6}, (_, index) => ({beat: index, key: 60})))
        source.beginTransaction()
        const file = createFile(source, "late")
        const group = createGroup(source, sampler, 0)
        createZone(source, sampler, group, file, 0, 127)
        source.endTransaction()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop()
        engine.play()
        const beat = (): number => {
            let peak = 0.0
            for (let quantum = 0; quantum < QUANTA_PER_BEAT; quantum++) {
                engine.render()
                const output = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len())
                output.forEach(value => peak = Math.max(peak, Math.abs(value)))
            }
            return peak
        }
        expect(beat(), "the sample is requested but not there yet").toBeLessThan(0.001)
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        expect(handle, "the zone's file was requested").toBeGreaterThanOrEqual(0)
        const pointer = engine.sample_allocate(handle, FRAMES * 4)
        new Float32Array(memory.buffer, pointer, FRAMES).fill(0.4)
        engine.sample_set_ready(handle, FRAMES, 1, 48000)
        beat()
        expect(beat(), "once resident, the next note plays it").toBeGreaterThan(0.05)
    }, 60000)
})
