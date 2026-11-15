// Surgeon in the FULL engine: it plays by itself while the transport runs, from the patterns stored in its box.
import {describe, expect, it} from "vitest"
import {int, Procedure, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SurgeonDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_BAR = 3840 * 25 // 48k, 120 bpm, 960 per quarter

type Note = { position: int, duration: int, pitch: int }

const Notes: ReadonlyArray<Note> = [
    {position: 240, duration: 700, pitch: 50}, {position: 1200, duration: 300, pitch: 57},
    {position: 1400, duration: 900, pitch: 45}, {position: 4000, duration: 2000, pitch: 52}
]

const session = async (setup: Procedure<SurgeonDeviceBox>, notes: ReadonlyArray<Note> = []) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const device = SurgeonDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        setup(box)
    })
    if (notes.length > 0) {
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        notes.forEach(({position, duration, pitch}) => NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
        }))
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(100_000)
            box.loopDuration.setValue(100_000)
        })
    }
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    return {
        engine, half,
        render: (frames: int): Float32Array => {
            const quanta = Math.ceil(frames / half)
            const left = new Float32Array(quanta * half)
            for (let index = 0; index < quanta; index++) {
                engine.render()
                left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), index * half)
            }
            return left
        },
        edit: async (procedure: Procedure<SurgeonDeviceBox>): Promise<void> => {
            source.beginTransaction()
            procedure(device)
            source.endTransaction()
            await sync.settle()
        },
        close: () => sync.close()
    }
}

const render = async (bars: int, setup: Procedure<SurgeonDeviceBox>, notes: ReadonlyArray<Note> = []): Promise<Float32Array> => {
    const {engine, render, close} = await session(setup, notes)
    engine.stop(); engine.play()
    const left = render(bars * SAMPLES_PER_BAR)
    close()
    return left
}

// FNV-1a over the bit patterns of the samples
const fingerprint = (samples: Float32Array): string => {
    const words = new Uint32Array(samples.buffer, samples.byteOffset, samples.length)
    let hash = 0xcbf29ce484222325n
    words.forEach(word => {hash = BigInt.asUintN(64, (hash ^ BigInt(word)) * 0x100000001b3n)})
    return hash.toString(16)
}

const rms = (samples: Float32Array, from: int, to: int): number => {
    let sum = 0.0
    for (let index = from; index < to; index++) {sum += samples[index] * samples[index]}
    return Math.sqrt(sum / (to - from))
}

describe("Surgeon in the full engine", () => {
    it("plays its default pattern by itself", async () => {
        const output = await render(2, () => {})
        expect(output.every(Number.isFinite)).toBe(true)
        expect(rms(output, 0, SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
        expect(rms(output, SAMPLES_PER_BAR, 2 * SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
    }, 300000)
    it("is silent when its slot is off", async () => {
        const output = await render(1, box => box.slot.setValue(-1))
        expect(rms(output, 0, SAMPLES_PER_BAR)).toBe(0.0)
    }, 300000)
    it("plays the pattern its slot names, from the stored values", async () => {
        const first = await render(1, () => {})
        const again = await render(1, () => {})
        expect(again.every((value, index) => value === first[index])).toBe(true)
        const second = await render(1, box => {
            box.slot.setValue(1)
            box.patterns.fields()[1].seed.setValue(4711)
        })
        expect(rms(second, 0, SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
        expect(second.some((value, index) => value !== first[index])).toBe(true)
    }, 300000)
    it("keeps its sound: the fingerprints were taken before the live controls became the selected pattern", async () => {
        expect(fingerprint(await render(2, () => {}))).toBe("6155579d367bcbb5")
        expect(fingerprint(await render(2, box => {
            box.slot.setValue(1)
            box.patterns.fields()[1].seed.setValue(4711)
        }))).toBe("f0af644e597563a3")
    }, 300000)
    it("plays the live controls for the selected pattern, not its stored values", async () => {
        const first = await render(1, () => {})
        const live = await render(1, box => box.live.seed.setValue(4711))
        expect(live.some((value, index) => value !== first[index])).toBe(true)
        const stored = await render(1, box => box.patterns.fields()[0].seed.setValue(4711))
        expect(stored.every((value, index) => value === first[index])).toBe(true)
        const moved = await render(1, box => {
            box.pattern.setValue(1)
            box.patterns.fields()[0].seed.setValue(4711)
        })
        expect(moved.every((value, index) => value === live[index])).toBe(true)
    }, 300000)
    it("plays the stored values of a pattern that is not selected", async () => {
        const first = await render(1, box => box.slot.setValue(1))
        const edited = await render(1, box => {
            box.slot.setValue(1)
            box.live.seed.setValue(4711)
        })
        expect(edited.every((value, index) => value === first[index])).toBe(true)
    }, 300000)
    it("a slot changed while playing takes over at the bar", async () => {
        const reference = await render(2, () => {})
        const {engine, render: play, edit, close} = await session(() => {})
        engine.stop(); engine.play()
        const start = play(SAMPLES_PER_BAR / 2)
        await edit(box => box.slot.setValue(-1))
        const rest = play(2 * SAMPLES_PER_BAR - start.length)
        close()
        const untilBar = SAMPLES_PER_BAR - start.length
        expect(start.every((value, index) => value === reference[index])).toBe(true)
        expect(rest.subarray(0, untilBar).every((value, index) => value === reference[start.length + index])).toBe(true)
        expect(rms(rest, untilBar + SAMPLES_PER_BAR / 2, rest.length)).toBeLessThan(rms(reference, SAMPLES_PER_BAR * 1.5, reference.length) * 0.1)
    }, 300000)
    it("a slot that waits for its bar is taken at once when the transport pauses", async () => {
        const {engine, half, render: play, edit, close} = await session(() => {})
        engine.stop(); engine.play()
        play(SAMPLES_PER_BAR / 4)
        await edit(box => box.slot.setValue(-1))
        const waiting = play(half)
        expect(rms(waiting, 0, waiting.length)).toBeGreaterThan(0.0)
        engine.pause()
        play(4 * SAMPLES_PER_BAR)
        engine.play()
        const output = play(SAMPLES_PER_BAR / 4)
        close()
        expect(rms(output, 0, output.length)).toBe(0.0)
    }, 300000)
    it("plays the notes of its track while the slot is off", async () => {
        const output = await render(2, box => box.slot.setValue(-1), Notes)
        expect(output.every(Number.isFinite)).toBe(true)
        expect(rms(output, 0, 6000)).toBe(0.0)
        expect(rms(output, 6000, SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
        expect(rms(output, SAMPLES_PER_BAR, 2 * SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
    }, 300000)
    it("keeps its sound with notes on its track while a pattern plays", async () => {
        expect(fingerprint(await render(2, () => {}, Notes))).toBe("6155579d367bcbb5")
    }, 300000)
    it("follows the volume", async () => {
        const full = await render(1, () => {})
        const quiet = await render(1, box => box.volume.setValue(-15.0)) // 12 dB under the default of -3 dB
        const ratio = rms(quiet, 0, SAMPLES_PER_BAR) / rms(full, 0, SAMPLES_PER_BAR)
        expect(ratio).toBeGreaterThan(0.22)
        expect(ratio).toBeLessThan(0.28)
    }, 300000)
})
