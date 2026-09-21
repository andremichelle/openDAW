// End-to-end behaviour of the Instrument Composite through the real engine.wasm, the cases only a full render
// proves. Every layer synth is an Apparat that outputs DC while a note is held, on ONE channel, with a level
// of pitch / 240 (pitch 60 = 0.25). So a channel's level identifies the layer, its pitch and its gain.
import {describe, expect, it} from "vitest"
import {Procedure, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    ApparatDeviceBox, AudioEffectCompositeBox, AudioEffectCompositeCellBox, AudioUnitBox, BoxIO, CaptureMidiBox,
    GrooveShuffleBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NoteClipBox, NoteEventBox,
    NoteEventCollectionBox, NoteRegionBox, PitchDeviceBox, StereoToolDeviceBox, TrackBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Graph = BoxGraph<BoxIO.TypeMap>
type Side = "left" | "right" | "both"

const QUANTUM = 128
const DB6 = Math.pow(10.0, -6.0 / 20.0)

const code = (side: Side) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, level: pitch / 240}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                ${side === "right" ? "" : "l[i] += voice.level;"} ${side === "left" ? "" : "r[i] += voice.level;"}
            }
        }
    }
}`

const createSynth = (graph: Graph, host: AudioUnitBox["input"] | InstrumentCompositeCellBox["instrument"], side: Side): void => {
    const script = code(side)
    const apparat = ApparatDeviceBox.create(graph, UUID.generate(), box => {
        box.host.refer(host)
        box.code.setValue("// @apparat js 1 1\n" + script)
    })
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, script))()
}

const createLayer = (graph: Graph, composite: InstrumentCompositeBox, index: number, side: Side): InstrumentCompositeCellBox => {
    const cell = InstrumentCompositeCellBox.create(graph, UUID.generate(), box => {
        box.composite.refer(composite.cells)
        box.index.setValue(index)
    })
    createSynth(graph, cell.instrument, side)
    return cell
}

type Scene = { graph: Graph, unit: AudioUnitBox }
type Session = {
    graph: Graph
    unit: AudioUnitBox
    // Renders `quanta` and returns both channels.
    render: (quanta: number) => { left: Float32Array, right: Float32Array }
    settle: () => Promise<void>
    stems: (quanta: number) => number
    // Launches the unit's note clip (pitch 72, one bar long) and reports how many clip transitions are queued.
    launchClip: () => void
    clipChanges: () => number
    restart: () => void
    close: () => void
}

const open = async (populate: Procedure<Scene>, stemFlags?: number): Promise<Session> => {
    const {boxGraph: graph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    graph.beginTransaction()
    const unit = AudioUnitBox.create(graph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(graph, UUID.generate()))
    populate({graph, unit})
    const track = TrackBox.create(graph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(graph, UUID.generate())
    NoteEventBox.create(graph, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.pitch.setValue(60)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(graph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    const clipEvents = NoteEventCollectionBox.create(graph, UUID.generate())
    NoteEventBox.create(graph, UUID.generate(), box => {
        box.events.refer(clipEvents.events)
        box.position.setValue(0)
        box.duration.setValue(3000)
        box.pitch.setValue(72)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    })
    const clip = NoteClipBox.create(graph, UUID.generate(), box => {
        box.clips.refer(track.clips)
        box.events.refer(clipEvents.owners)
        box.duration.setValue(3840)
    })
    graph.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, graph)
    await sync.settle()
    if (stemFlags !== undefined) {
        const pointer = engine.input_reserve(20)
        new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
        new DataView(memory.buffer, pointer, 20).setUint32(16, stemFlags, true)
        engine.set_stem_export(1)
    }
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    return {
        graph, unit,
        render: quanta => {
            const left = new Float32Array(quanta * half)
            const right = new Float32Array(quanta * half)
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const pointer = engine.output_ptr()
                left.set(new Float32Array(memory.buffer, pointer, half), quantum * half)
                right.set(new Float32Array(memory.buffer, pointer + half * 4, half), quantum * half)
            }
            return {left, right}
        },
        settle: () => sync.settle(),
        stems: quanta => {
            let peak = 0.0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * QUANTUM)
                    .forEach(value => peak = Math.max(peak, Math.abs(value)))
            }
            return peak
        },
        launchClip: () => {
            new Uint8Array(memory.buffer, engine.input_reserve(16), 16).set(clip.address.uuid)
            engine.schedule_clip_play()
        },
        clipChanges: () => engine.clip_changes_count() >>> 0,
        restart: () => {engine.stop(); engine.play()},
        close: () => sync.close()
    }
}

const last = (channel: Float32Array): number => channel[channel.length - 1]
const compositeOf = ({graph, unit}: Scene): InstrumentCompositeBox =>
    InstrumentCompositeBox.create(graph, UUID.generate(), box => box.host.refer(unit.input))

describe("instrument composite end to end", () => {
    it("one layer renders sample for sample what the bare instrument renders", async () => {
        const bare = await open(({graph, unit}) => createSynth(graph, unit.input, "both"))
        const layered = await open(scene => {createLayer(scene.graph, compositeOf(scene), 0, "both")})
        const expected = bare.render(200)
        const actual = layered.render(200)
        expect(expected.left.some(value => value > 0.2)).toBe(true)
        expect(Array.from(actual.left)).toStrictEqual(Array.from(expected.left))
        expect(Array.from(actual.right)).toStrictEqual(Array.from(expected.right))
        bare.close(); layered.close()
    }, 60000)

    it("a layer's audio effect reaches that layer only", async () => {
        const session = await open(scene => {
            const composite = compositeOf(scene)
            const layerA = createLayer(scene.graph, composite, 0, "left")
            createLayer(scene.graph, composite, 1, "right")
            StereoToolDeviceBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(layerA.audioEffects)
                box.index.setValue(0)
                box.volume.setValue(-6.0)
            })
        })
        const {left, right} = session.render(200)
        expect(last(left)).toBeCloseTo(0.25 * DB6, 3)
        expect(last(right)).toBeCloseTo(0.25, 5)
        session.close()
    }, 60000)

    it("a layer's midi effect reaches that layer only", async () => {
        const session = await open(scene => {
            const composite = compositeOf(scene)
            const layerA = createLayer(scene.graph, composite, 0, "left")
            createLayer(scene.graph, composite, 1, "right")
            PitchDeviceBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(layerA.midiEffects)
                box.index.setValue(0)
                box.semiTones.setValue(12)
            })
        })
        const {left, right} = session.render(200)
        expect(last(left), "layer A hears the note an octave up").toBeCloseTo(72 / 240, 5)
        expect(last(right), "layer B hears the note as written").toBeCloseTo(60 / 240, 5)
        session.close()
    }, 60000)

    it("an FX Composite inside a layer processes that layer", async () => {
        const session = await open(scene => {
            const composite = compositeOf(scene)
            const layerA = createLayer(scene.graph, composite, 0, "left")
            createLayer(scene.graph, composite, 1, "right")
            const stack = AudioEffectCompositeBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(layerA.audioEffects)
                box.index.setValue(0)
            })
            const entry = AudioEffectCompositeCellBox.create(scene.graph, UUID.generate(), box => {
                box.composite.refer(stack.entries)
                box.index.setValue(0)
            })
            StereoToolDeviceBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(entry.audioEffects)
                box.index.setValue(0)
                box.volume.setValue(-6.0)
            })
        })
        const {left, right} = session.render(200)
        expect(last(left)).toBeCloseTo(0.25 * DB6, 3)
        expect(last(right)).toBeCloseTo(0.25, 5)
        session.close()
    }, 60000)

    it("a layer joins and leaves while playing, the other layer never drops out", async () => {
        const kept: Array<InstrumentCompositeCellBox> = []
        const session = await open(scene => {kept.push(createLayer(scene.graph, compositeOf(scene), 0, "right"))})
        const composite = kept[0].composite.targetVertex.unwrap("composite").box as InstrumentCompositeBox
        session.render(100)
        session.graph.beginTransaction()
        const joiner = createLayer(session.graph, composite, 1, "left")
        session.graph.endTransaction()
        await session.settle()
        const joined = session.render(200)
        // The joiner's note started before it existed, so it stays silent until the next note. What matters:
        expect(Math.min(...joined.right), "the running layer keeps sounding through the join").toBeCloseTo(0.25, 5)
        session.graph.beginTransaction()
        joiner.delete()
        session.graph.endTransaction()
        await session.settle()
        const left = session.render(200)
        expect(Math.min(...left.right), "and through the leave").toBeCloseTo(0.25, 5)
        expect(Math.max(...left.left.subarray(left.left.length >>> 1).map(Math.abs))).toBeLessThan(1e-4)
        session.close()
    }, 60000)

    it("wrapping the playing instrument into a Composite: the held note ends, the next note sounds", async () => {
        const session = await open(({graph, unit}) => createSynth(graph, unit.input, "right"))
        const before = session.render(100)
        expect(Math.min(...before.right)).toBeCloseTo(0.25, 5)
        const synth = session.unit.input.pointerHub.incoming()[0].box as ApparatDeviceBox
        session.graph.beginTransaction()
        synth.host.defer()
        const composite = compositeOf(session)
        const cell = InstrumentCompositeCellBox.create(session.graph, UUID.generate(), box => {
            box.composite.refer(composite.cells)
            box.index.setValue(0)
        })
        synth.host.refer(cell.instrument)
        session.graph.endTransaction()
        await session.settle()
        const after = session.render(100)
        // like a joining layer, the re-hosted synth never saw the running note's start
        expect(Math.max(...after.right.subarray(after.right.length >>> 1).map(Math.abs))).toBeLessThan(1e-4)
        session.restart()
        const restarted = session.render(100)
        expect(Math.min(...restarted.right.subarray(restarted.right.length >>> 1)), "the wrapped synth sounds again").toBeCloseTo(0.25, 5)
        session.close()
    }, 60000)

    it("a launched clip hands over once and at the same bar for a straight and a grooved layer", async () => {
        const SAMPLES_PER_PULSE = 48000 / (120.0 / 60.0 * 960.0)
        const session = await open(scene => {
            const composite = compositeOf(scene)
            const grooved = createLayer(scene.graph, composite, 0, "left")
            createLayer(scene.graph, composite, 1, "right")
            const groove = GrooveShuffleBox.create(scene.graph, UUID.generate(), box => {
                box.label.setValue("Shuffle")
                box.duration.setValue(480)
                box.amount.setValue(0.6)
            })
            ZeitgeistDeviceBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(grooved.midiEffects)
                box.groove.refer(groove)
                box.index.setValue(0)
            })
        })
        // Launched mid-bar, so the handover waits for the next bar (a launch before the first block lands on bar 0).
        const before = 100
        session.render(before)
        session.launchClip()
        const {left, right} = session.render(Math.ceil(1.5 * 3840 * SAMPLES_PER_PULSE / QUANTUM))
        // The long timeline note keeps its full duration past the handover, so the clip's note ADDS to it.
        const handover = (channel: Float32Array): number =>
            before * QUANTUM + channel.findIndex(value => Math.abs(value - (60 + 72) / 240) < 1e-4)
        const bar = 3840 * SAMPLES_PER_PULSE
        expect(Math.abs(handover(right) - bar), `straight layer hands over at the bar, got ${handover(right)}`).toBeLessThan(QUANTUM)
        expect(Math.abs(handover(left) - bar), `grooved layer hands over at the bar, got ${handover(left)}`).toBeLessThan(QUANTUM)
        expect(right[Math.floor(bar) - (before + 4) * QUANTUM], "the timeline note sounds before the bar").toBeCloseTo(60 / 240, 5)
        expect(session.clipChanges(), "one Started for two layers").toBe(1)
        session.close()
    }, 60000)

    it("stems of a composite unit tap the same points as a plain unit", async () => {
        const FLAGS_DEFAULT = 1 | 2
        const FLAGS_NO_FX = 2
        const FLAGS_INSTRUMENT = 1 | 2 | 4
        const FLAGS_NO_STRIP = 1 | 2 | 8
        const populate = (layered: boolean): Procedure<Scene> => scene => {
            scene.unit.volume.setValue(-12.0)
            if (layered) {
                const composite = compositeOf(scene)
                createLayer(scene.graph, composite, 0, "both")
            } else {
                createSynth(scene.graph, scene.unit.input, "both")
            }
            StereoToolDeviceBox.create(scene.graph, UUID.generate(), box => {
                box.host.refer(scene.unit.audioEffects)
                box.index.setValue(0)
                box.volume.setValue(-24.0)
            })
        }
        for (const flags of [FLAGS_DEFAULT, FLAGS_NO_FX, FLAGS_INSTRUMENT, FLAGS_NO_STRIP]) {
            const plain = await open(populate(false), flags)
            const layered = await open(populate(true), flags)
            const expected = plain.stems(200)
            expect(expected, `flags ${flags}: the plain unit's stem sounds`).toBeGreaterThan(1e-4)
            expect(layered.stems(200), `flags ${flags}`).toBeCloseTo(expected, 5)
            plain.close(); layered.close()
        }
    }, 120000)
})
