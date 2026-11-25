// End-to-end: the enhanced Arpeggio's plain fields (step lanes, pattern length, seed) and the migrated mode
// automation reach the wasm device. An Apparat instrument outputs a DC level that encodes the held pitch
// ((pitch - 40) / 100) only while a note is held, so every arp hit becomes a pulse whose height names its pitch.
import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    ArpeggioDeviceBox,
    AudioUnitBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {DeviceMigration, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const CODE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, pitch}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length === 0) return
        const level = (Math.max(...this.voices.map(voice => voice.pitch)) - 40) / 100
        for (let i = block.s0; i < block.s1; i++) { l[i] += level; r[i] += level }
    }
}`

type Setup = (arp: ArpeggioDeviceBox, source: ProjectSkeleton["boxGraph"], skeleton: ProjectSkeleton) => void

// Renders ~2 seconds at 120 bpm (1/16 = 125 ms) and returns the pitch of every pulse in order.
const renderPulses = async (setup: Setup, pitches: ReadonlyArray<number> = [60], migrate: boolean = false): Promise<Array<number>> => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + CODE)
    })
    const arp = ArpeggioDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.gate.setValue(0.5)
        box.version.setValue(migrate ? 0 : 1)
    })
    setup(arp, source, skeleton)
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    pitches.forEach(pitch => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    source.endTransaction()
    if (migrate) {DeviceMigration.migrate(source)}
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, CODE))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    const quanta = Math.ceil(2 * 48000 / half)
    engine.stop(); engine.play()
    const left = new Float32Array(quanta * half)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
    }
    const pulses: Array<number> = []
    for (let index = 0; index < left.length - 64; index++) {
        if ((index === 0 || left[index - 1] <= 1e-6) && left[index] > 0.05) {
            pulses.push(Math.round(left[index + 32] * 100 + 40))
        }
    }
    return pulses
}

const automate = (arp: ArpeggioDeviceBox, graph: ProjectSkeleton["boxGraph"], target: ArpeggioDeviceBox["gate"],
                  points: ReadonlyArray<[number, number]>, interpolation: number) => {
    const track = TrackBox.create(graph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.target.refer(target)
        box.index.setValue(1)
        box.tracks.refer(asInstanceOf(arp.host.targetVertex.unwrap().box, AudioUnitBox).tracks)
    })
    const collection = ValueEventCollectionBox.create(graph, UUID.generate())
    ValueRegionBox.create(graph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    points.forEach(([position, value], index) => ValueEventBox.create(graph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(position)
        box.index.setValue(index)
        box.interpolation.setValue(interpolation)
        box.value.setValue(value)
    }))
}

const setLane = (field: ArpeggioDeviceBox["stepKinds"], values: Record<number, number>) =>
    Object.entries(values).forEach(([slot, value]) => field.getField(Number(slot)).setValue(value))

describe("arp steps (engine)", () => {
    it("plays one pulse per 1/16 step by default", async () => {
        const pulses = await renderPulses(() => {})
        expect(pulses.length).toBeGreaterThanOrEqual(15)
        expect(pulses.length).toBeLessThanOrEqual(17)
        expect(pulses.every(pitch => pitch === 60)).toBe(true)
    }, 60000)
    it("honors rest steps and the pattern length", async () => {
        const all = await renderPulses(() => {})
        const halved = await renderPulses(arp => {
            arp.patternLength.setValue(2)
            setLane(arp.stepKinds, {1: 1})
        })
        expect(Math.abs(halved.length - all.length / 2)).toBeLessThanOrEqual(1)
    }, 60000)
    it("honors ratchets", async () => {
        const all = await renderPulses(() => {})
        const ratcheted = await renderPulses(arp => {
            for (let slot = 0; slot < 64; slot++) {arp.stepRatchets.getField(slot).setValue(2)}
        })
        expect(Math.abs(ratcheted.length - all.length * 2)).toBeLessThanOrEqual(2)
    }, 60000)
    it("honors the transpose and octave lanes", async () => {
        const pulses = await renderPulses(arp => {
            arp.patternLength.setValue(2)
            setLane(arp.stepTransposes, {1: 7})
            setLane(arp.stepOctaves, {0: -1})
        })
        expect(pulses.slice(0, 4)).toEqual([48, 67, 48, 67])
    }, 60000)
    it("honors chance zero and the seed", async () => {
        const silent = await renderPulses(arp => {
            for (let slot = 0; slot < 64; slot++) {arp.stepChances.getField(slot).setValue(0)}
        })
        expect(silent.length).toBe(0)
        const half = (seed: number) => renderPulses(arp => {
            arp.seed.setValue(seed)
            arp.patternLength.setValue(1)
            arp.stepChances.getField(0).setValue(50)
            arp.modeIndex.setValue(13)
        }, [60, 64, 67, 71])
        const first = await half(1)
        const again = await half(1)
        const other = await half(2)
        expect(again).toEqual(first)
        expect(other).not.toEqual(first)
    }, 60000)
    it("plays the new walks", async () => {
        const pulses = await renderPulses(arp => arp.modeIndex.setValue(6), [60, 64, 67, 71])
        expect(pulses.slice(0, 8)).toEqual([60, 71, 64, 67, 60, 71, 64, 67])
    }, 60000)
    it("restarts Retrigger Bar at the bars of the project signature", async () => {
        const chord = [60, 62, 64, 65, 67]
        const pulses = (nominator: number) => renderPulses((arp, _graph, skeleton) => {
            skeleton.mandatoryBoxes.timelineBox.signature.nominator.setValue(nominator)
            arp.retrigger.setValue(2)
        }, chord)
        const threeFour = await pulses(3)
        const fourFour = await pulses(4)
        expect(threeFour.slice(10, 14)).toEqual([60, 62, 60, 62])
        expect(fourFour.slice(10, 16)).toEqual([60, 62, 64, 65, 67, 60])
    }, 60000)
    it("keeps the held chord across a loop wrap inside a block with automation updates", async () => {
        const loop = (skeleton: ProjectSkeleton) => {
            const {loopArea} = skeleton.mandatoryBoxes.timelineBox
            loopArea.enabled.setValue(true)
            loopArea.from.setValue(0)
            loopArea.to.setValue(960)
        }
        const plain = await renderPulses((_arp, _graph, skeleton) => loop(skeleton))
        const automated = await renderPulses((arp, graph, skeleton) => {
            loop(skeleton)
            automate(arp, graph, arp.gate, [[0, 0.2], [960, 0.4], [200_000, 0.4]], 1)
        })
        expect(plain.length).toBeGreaterThanOrEqual(15)
        expect(automated.length).toBe(plain.length)
    }, 60000)
    it("plays a migrated legacy UpDown automation as UpDown", async () => {
        const pulses = await renderPulses((arp, graph) => {
            const track = TrackBox.create(graph, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.target.refer(arp.modeIndex)
                box.index.setValue(1)
                box.tracks.refer(asInstanceOf(arp.host.targetVertex.unwrap().box, AudioUnitBox).tracks)
            })
            const collection = ValueEventCollectionBox.create(graph, UUID.generate())
            ValueRegionBox.create(graph, UUID.generate(), box => {
                box.regions.refer(track.regions)
                box.events.refer(collection.owners)
                box.duration.setValue(200_000)
                box.loopDuration.setValue(200_000)
            })
            ValueEventBox.create(graph, UUID.generate(), box => {
                box.events.refer(collection.events)
                box.interpolation.setValue(0)
                box.value.setValue(1.0) // UpDown in the legacy 3-mode mapping
            })
        }, [60, 64, 67], true)
        expect(pulses.slice(0, 6)).toEqual([60, 64, 67, 64, 60, 64])
    }, 60000)
})
