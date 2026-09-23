// AUDIO SINK (AudioSinkDeviceBox): a 1:1 cable IN an audio chain that sums its input into a target bus.
//   pass -inf (default): the chain (and the unit strip) continue silent, the unit sounds only through the bus.
//   pass 0 dB: an identical copy continues down the chain (dry + bus), anything between scales the dry copy.
//   no / unregistered target: nothing is sent, no master fallback (silence at pass -inf).
//   enabled off: bypass, chain untouched, nothing sent.
// It is a chain member, so it works inside a composite cell's chain and an FX stack entry too. For stems it
// is an OUTPUT route: never gated by includeSends.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    AudioBusBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    AudioSinkDeviceBox,
    AudioUnitBox,
    InstrumentCompositeBox,
    InstrumentCompositeCellBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.4, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

type SineHost = AudioUnitBox["input"] | InstrumentCompositeCellBox["instrument"]

const createSine = (source: BoxGraph, host: SineHost): void => {
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, SYNTH))()
}

const addHeldNote = (source: BoxGraph, unit: AudioUnitBox): void => {
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.pitch.setValue(69)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
}

type Skeleton = ReturnType<typeof ProjectSkeleton.empty>

const skeleton = (): Skeleton => ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})

// A submix bus (its AudioBusBox + bus unit -> master) at `volumeDb`.
const createBus = ({boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}}: Skeleton, volumeDb: number): AudioBusBox => {
    const bus = AudioBusBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses)
        box.output.refer(primaryAudioBusBox.input)
        box.label.setValue("Group")
    })
    const busUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.type.setValue("bus")
        box.output.refer(primaryAudioBusBox.input)
        box.volume.setValue(volumeDb)
        box.index.setValue(2)
    })
    bus.output.refer(busUnit.input)
    return bus
}

type SinkOptions = { pass?: number, enabled?: boolean }

// `pass` in dB: -inf (the box default) = the chain goes silent after the sink, 0 = a full copy continues.
const createSink = (source: BoxGraph, host: Field<Pointers.AudioEffectHost>, target: AudioBusBox["input"] | undefined,
                    {pass = Number.NEGATIVE_INFINITY, enabled = true}: SinkOptions = {}): AudioSinkDeviceBox =>
    AudioSinkDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.index.setValue(0)
        box.enabled.setValue(enabled)
        box.pass.setValue(pass)
        if (target !== undefined) {box.targetBus.refer(target)}
    })

// An instrument unit (sine + held note) routed to the master.
const createInstrumentUnit = ({boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}}: Skeleton): AudioUnitBox => {
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    addHeldNote(source, unit)
    return unit
}

const renderPeak = async (source: BoxGraph, quanta = 48): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {
            expect(Number.isFinite(out[i])).toBe(true)
            peak = Math.max(peak, Math.abs(out[i]))
        }
    }
    return peak
}

const withinPercent = (value: number, reference: number, percent: number): boolean =>
    Math.abs(value - reference) < reference * percent / 100

const MINUS_12_DB = Math.pow(10, -12 / 20)

const directPeak = async (): Promise<number> => {
    const project = skeleton()
    project.boxGraph.beginTransaction()
    createSine(project.boxGraph, createInstrumentUnit(project).input)
    project.boxGraph.endTransaction()
    return renderPeak(project.boxGraph)
}

describe("audio sink", () => {
    it("without a target and at pass -inf the unit is silent (no master fallback)", async () => {
        const direct = await directPeak()
        expect(direct).toBeGreaterThan(0.05)
        const project = skeleton()
        project.boxGraph.beginTransaction()
        const unit = createInstrumentUnit(project)
        createSine(project.boxGraph, unit.input)
        createSink(project.boxGraph, unit.audioEffects, undefined)
        project.boxGraph.endTransaction()
        expect(await renderPeak(project.boxGraph)).toBeLessThan(direct / 100)
    }, 60000)

    it("routes the signal into the bus only; the bus fader scales it", async () => {
        const direct = await directPeak()
        const build = (busVolumeDb: number): BoxGraph => {
            const project = skeleton()
            project.boxGraph.beginTransaction()
            const unit = createInstrumentUnit(project)
            createSine(project.boxGraph, unit.input)
            const bus = createBus(project, busVolumeDb)
            createSink(project.boxGraph, unit.audioEffects, bus.input)
            project.boxGraph.endTransaction()
            return project.boxGraph
        }
        const routed = await renderPeak(build(0.0))
        expect(withinPercent(routed, direct, 10), `0 dB bus == direct (routed ${routed}, direct ${direct})`).toBe(true)
        const attenuated = await renderPeak(build(-12.0))
        expect(withinPercent(attenuated, direct * MINUS_12_DB, 20), `only the bus path sounds (${attenuated})`).toBe(true)
    }, 60000)

    it("pass at 0 dB keeps the dry path: dry + bus copy roughly doubles the level", async () => {
        const direct = await directPeak()
        const build = (passDb: number): BoxGraph => {
            const project = skeleton()
            project.boxGraph.beginTransaction()
            const unit = createInstrumentUnit(project)
            createSine(project.boxGraph, unit.input)
            const bus = createBus(project, 0.0)
            createSink(project.boxGraph, unit.audioEffects, bus.input, {pass: passDb})
            project.boxGraph.endTransaction()
            return project.boxGraph
        }
        expect(await renderPeak(build(0.0))).toBeGreaterThan(direct * 1.5)
        // A partial pass level scales only the chain copy: bus (unity) + dry at -12 dB.
        const partial = await renderPeak(build(-12.0))
        expect(withinPercent(partial, direct * (1 + MINUS_12_DB), 15), `bus + dry at -12 dB (${partial}, direct ${direct})`).toBe(true)
    }, 60000)

    it("a disabled sink is a bypass: dry path only, nothing sent", async () => {
        const direct = await directPeak()
        const project = skeleton()
        project.boxGraph.beginTransaction()
        const unit = createInstrumentUnit(project)
        createSine(project.boxGraph, unit.input)
        const bus = createBus(project, 0.0)
        createSink(project.boxGraph, unit.audioEffects, bus.input, {enabled: false})
        project.boxGraph.endTransaction()
        const bypassed = await renderPeak(project.boxGraph)
        expect(withinPercent(bypassed, direct, 10), `bypass == direct (${bypassed} vs ${direct})`).toBe(true)
    }, 60000)

    it("a sink in a composite cell's chain groups that cell on the bus (#350)", async () => {
        // Two cells with the same sine: without sinks both go to the master (double level). With a sink in
        // cell B's chain into a -12 dB bus, the master carries cell A dry + cell B at -12 dB.
        const build = (withSink: boolean): BoxGraph => {
            const project = skeleton()
            project.boxGraph.beginTransaction()
            const unit = createInstrumentUnit(project)
            const composite = InstrumentCompositeBox.create(project.boxGraph, UUID.generate(), box => box.host.refer(unit.input))
            const cells = [0, 1].map(index => InstrumentCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.cells)
                box.index.setValue(index)
            }))
            cells.forEach(cell => createSine(project.boxGraph, cell.instrument))
            if (withSink) {
                const bus = createBus(project, -12.0)
                createSink(project.boxGraph, cells[1].audioEffects, bus.input)
            }
            project.boxGraph.endTransaction()
            return project.boxGraph
        }
        const both = await renderPeak(build(false))
        const grouped = await renderPeak(build(true))
        const single = both / 2
        expect(withinPercent(grouped, single * (1 + MINUS_12_DB), 15), `cell A + cell B via -12 dB bus (${grouped}, both ${both})`).toBe(true)
    }, 60000)

    it("a sink inside an FX stack entry routes that branch to the bus", async () => {
        // Stack with dry -inf / wet 0 dB and ONE entry holding the sink (pass -inf): the wet branch is
        // silent after the sink, so the master hears the unit only via the -12 dB bus.
        const direct = await directPeak()
        const project = skeleton()
        project.boxGraph.beginTransaction()
        const unit = createInstrumentUnit(project)
        createSine(project.boxGraph, unit.input)
        const bus = createBus(project, -12.0)
        const stack = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.dry.setValue(Number.NEGATIVE_INFINITY)
            box.wet.setValue(0.0)
        })
        const entry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
            box.composite.refer(stack.entries)
            box.index.setValue(0)
        })
        createSink(project.boxGraph, entry.audioEffects, bus.input)
        project.boxGraph.endTransaction()
        const peak = await renderPeak(project.boxGraph)
        expect(withinPercent(peak, direct * MINUS_12_DB, 20), `entry branch via the bus only (${peak}, direct ${direct})`).toBe(true)
    }, 60000)

    it("stems: the sunk signal lands in the bus stem even with includeSends=false", async () => {
        const project = skeleton()
        project.boxGraph.beginTransaction()
        const unit = createInstrumentUnit(project)
        createSine(project.boxGraph, unit.input)
        const bus = createBus(project, 0.0)
        createSink(project.boxGraph, unit.audioEffects, bus.input)
        const busUnit = bus.output.targetVertex.unwrap("bus unit").box as AudioUnitBox
        project.boxGraph.endTransaction()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, project.boxGraph)
        await sync.settle()
        const INCLUDE_AUDIO_EFFECTS_ONLY = 1 // includeSends (2) OFF
        const pointer = engine.input_reserve(2 * 20)
        const view = new DataView(memory.buffer, pointer, 2 * 20)
        const stems = [unit, busUnit]
        stems.forEach((stem, index) => {
            new Uint8Array(memory.buffer, pointer + index * 20, 16).set(stem.address.uuid)
            view.setUint32(index * 20 + 16, INCLUDE_AUDIO_EFFECTS_ONLY, true)
        })
        engine.set_stem_export(2)
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const peaks: [number, number] = [0, 0]
        for (let quantum = 0; quantum < 48; quantum++) {
            engine.render()
            const staging = new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * 2 * QUANTUM)
            for (let stem = 0; stem < 2; stem++) {
                for (let index = 0; index < 2 * QUANTUM; index++) {
                    peaks[stem] = Math.max(peaks[stem], Math.abs(staging[stem * 2 * QUANTUM + index]))
                }
            }
        }
        const [unitStem, busStem] = peaks
        expect(busStem, "the bus stem carries the sunk signal").toBeGreaterThan(0.05)
        expect(unitStem, "the unit stem is silent after the sink (pass -inf)").toBeLessThan(busStem / 100)
    }, 60000)
})
