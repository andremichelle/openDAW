// A unit-level ARP in front of an Instrument Composite must feed EVERY layer the same steps a bare unit gets.
// Each layer is an Apparat that outputs DC on ONE channel while a note is held (layer A left, layer B right),
// so the rising edges per channel count the arp steps that layer received. The arp is stateful, so two layers
// pulling ONE shared instance over the same window corrupt each other.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {Interpolation} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, BoxIO, InstrumentCompositeBox, InstrumentCompositeCellBox,
    NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox
} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const code = (left: number, right: number) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += ${left}; r[i] += ${right} } }
    }
}`

const LEFT = code(0.3, 0.0)
const RIGHT = code(0.0, 0.3)
const BOTH = code(0.3, 0.3)

type Steps = { left: number, right: number, peakLeft: number, peakRight: number, lateLeft: number }

const createApparat = (graph: BoxGraph<BoxIO.TypeMap>, host: AudioUnitBox["input"] | InstrumentCompositeCellBox["instrument"],
                       source: string): void => {
    const apparat = ApparatDeviceBox.create(graph, UUID.generate(), box => {
        box.host.refer(host)
        box.code.setValue("// @apparat js 1 1\n" + source)
    })
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, source))()
}

const countSteps = async (layers: ReadonlyArray<string>, arp: boolean = true, automatedRate?: number,
                          layerArp: boolean = false, live: boolean | "stopped" = false, lateArp: boolean = false): Promise<Steps> => {
    const cells: Array<InstrumentCompositeCellBox> = []
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    if (layers.length === 0) {
        createApparat(source, unit.input, BOTH)
    } else {
        const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        layers.forEach((layer, index) => {
            const cell = InstrumentCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.cells)
                box.index.setValue(index)
            })
            createApparat(source, cell.instrument, layer)
            cells.push(cell)
            if (layerArp) {
                ArpeggioDeviceBox.create(source, UUID.generate(), box => {
                    box.host.refer(cell.midiEffects)
                    box.rateIndex.setValue(9)
                    box.gate.setValue(0.5)
                })
            }
        })
    }
    if (arp) {
        const arpeggio = ArpeggioDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.rateIndex.setValue(9)
            box.gate.setValue(0.5)
        })
        if (automatedRate !== undefined) {
            const rateTrack = TrackBox.create(source, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.enabled.setValue(true)
                box.index.setValue(1)
                box.target.refer(arpeggio.rateIndex)
                box.tracks.refer(unit.tracks)
            })
            const rateEvents = ValueEventCollectionBox.create(source, UUID.generate())
            ValueEventBox.create(source, UUID.generate(), box => {
                box.position.setValue(0)
                box.value.setValue(automatedRate)
                box.index.setValue(0)
                box.slope.setValue(NaN)
                box.events.refer(rateEvents.events)
                InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
            })
            ValueRegionBox.create(source, UUID.generate(), box => {
                box.position.setValue(0)
                box.duration.setValue(200_000)
                box.loopDuration.setValue(200_000)
                box.regions.refer(rateTrack.regions)
                box.events.refer(rateEvents.owners)
            })
        }
    }
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    // A late arp only sees notes that START after it joined, so that case plays one long note per bar.
    const notes = live !== false ? [] : lateArp
        ? Array.from({length: 8}, (_, bar) => ({position: bar * 3840, duration: 3600, pitch: 60}))
        : [60, 64, 67].map(pitch => ({position: 0, duration: 200_000, pitch}))
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
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const half = len >>> 1
    const QUANTA = Math.ceil(4 * 48000 / half)
    engine.stop()
    if (live !== "stopped") {engine.play()}
    if (live !== false) {
        // LIVE keys: the unit's uuid goes through the input scratch, like the worklet does.
        for (const pitch of [60, 64, 67]) {
            new Uint8Array(memory.buffer, engine.input_reserve(16), 16).set(unit.address.uuid)
            engine.note_signal_on(pitch, 0.8)
        }
    }
    if (lateArp) {
        // The studio flow: the layers already run, THEN the arp is dropped into each layer's midi chain.
        for (let quantum = 0; quantum < 50; quantum++) {engine.render()}
        source.beginTransaction()
        const hosts = cells.length === 0 ? [unit.midiEffects] : cells.map(cell => cell.midiEffects)
        hosts.forEach(host => ArpeggioDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(host)
            box.index.setValue(0)
            box.rateIndex.setValue(9)
            box.gate.setValue(0.5)
        }))
        source.endTransaction()
        await sync.settle()
    }
    const left = new Float32Array(QUANTA * half)
    const right = new Float32Array(QUANTA * half)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        if (process.env.ARP_STOP_HALFWAY === "1" && quantum === QUANTA >>> 1) {engine.stop()}
        engine.render()
        const enginePtr = engine.output_ptr()
        left.set(new Float32Array(memory.buffer, enginePtr, half), quantum * half)
        right.set(new Float32Array(memory.buffer, enginePtr + half * 4, half), quantum * half)
    }
    const edges = (channel: Float32Array): number => {
        let steps = 0
        for (let index = 1; index < channel.length; index++) {
            if (channel[index - 1] <= 1e-6 && channel[index] > 0.1) {steps++}
        }
        return steps
    }
    const peak = (channel: Float32Array): number => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    const lateLeft = edges(left.subarray((left.length >>> 1) + 4800))
    return {left: edges(left), right: edges(right), peakLeft: peak(left), peakRight: peak(right), lateLeft}
}

describe("instrument composite behind a unit-level arp", () => {
    it("two layers without an arp both sound", async () => {
        const layered = await countSteps([LEFT, RIGHT], false)
        expect(layered.peakLeft).toBeCloseTo(0.3, 5)
        expect(layered.peakRight).toBeCloseTo(0.3, 5)
    }, 60000)

    it("one layer gets exactly the steps of the bare unit", async () => {
        const bare = await countSteps([])
        const single = await countSteps([BOTH])
        console.log(`bare=${JSON.stringify(bare)} single=${JSON.stringify(single)}`)
        expect(bare.left).toBeGreaterThan(20)
        expect(single).toEqual(bare)
    }, 60000)

    it("rate automation on the unit-level arp reaches every layer's replica", async () => {
        const free = await countSteps([], true)
        const bare = await countSteps([], true, 0.3)
        const layered = await countSteps([LEFT, RIGHT], true, 0.3)
        console.log(`free=${free.left} automated bare=${bare.left} layered=${layered.left}/${layered.right}`)
        expect(bare.left, "the automation slows the arp down").toBeLessThan(free.left / 2)
        expect(bare.left).toBeGreaterThan(2)
        expect(layered.left).toBe(bare.left)
        expect(layered.right).toBe(bare.right)
    }, 60000)

    it("an arp inside a layer's OWN midi chain steps like the bare unit's arp", async () => {
        const bare = await countSteps([], true)
        const layered = await countSteps([LEFT, RIGHT], false, undefined, true)
        console.log(`bare=${bare.left} layer arps=${layered.left}/${layered.right} peaks=${layered.peakLeft}/${layered.peakRight}`)
        expect(layered.left).toBe(bare.left)
        expect(layered.right).toBe(bare.right)
    }, 60000)

    it("an arp ADDED to running layers takes over their notes", async () => {
        const bare = await countSteps([], false, undefined, false, false, true)
        const late = await countSteps([LEFT, RIGHT], false, undefined, false, false, true)
        console.log(`late arp bare=${bare.left} layers=${late.left}/${late.right}`)
        expect(bare.left).toBeGreaterThan(10)
        expect([late.left, late.right]).toStrictEqual([bare.left, bare.right])
    }, 60000)

    it("stopping the transport silences an arp that was stepping SEQUENCED notes", async () => {
        process.env.ARP_STOP_HALFWAY = "1"
        const bare = await countSteps([], true)
        const layered = await countSteps([LEFT, RIGHT], true)
        delete process.env.ARP_STOP_HALFWAY
        console.log(`stop halfway bare=${bare.left} late=${bare.lateLeft} layered late=${layered.lateLeft}`)
        expect(bare.left).toBeGreaterThan(10)
        expect(bare.lateLeft, "no step once the sequenced notes were released by the stop").toBe(0)
        expect(layered.lateLeft).toBe(0)
    }, 60000)

    it("LIVE notes on a STOPPED transport are arpeggiated, plain unit and layers alike", async () => {
        const bare = await countSteps([], true, undefined, false, "stopped")
        const unitArp = await countSteps([LEFT, RIGHT], true, undefined, false, "stopped")
        const layerArp = await countSteps([LEFT, RIGHT], false, undefined, true, "stopped")
        console.log(`stopped bare=${bare.left} unitArp=${unitArp.left}/${unitArp.right} layerArp=${layerArp.left}/${layerArp.right}`)
        expect(bare.left, "a held key steps on the free-running grid").toBeGreaterThan(20)
        expect([unitArp.left, unitArp.right]).toStrictEqual([bare.left, bare.right])
        expect([layerArp.left, layerArp.right]).toStrictEqual([bare.left, bare.right])
    }, 60000)

    it("LIVE notes while playing: an arp in front of or inside the layers steps like the bare unit's arp", async () => {
        const bare = await countSteps([], true, undefined, false, true)
        const unitArp = await countSteps([LEFT, RIGHT], true, undefined, false, true)
        const layerArp = await countSteps([LEFT, RIGHT], false, undefined, true, true)
        console.log(`live bare=${bare.left}/${bare.peakLeft} unitArp=${unitArp.left}/${unitArp.right} layerArp=${layerArp.left}/${layerArp.right} peaks=${layerArp.peakLeft}`)
        expect(bare.left).toBeGreaterThan(20)
        expect([unitArp.left, unitArp.right]).toStrictEqual([bare.left, bare.right])
        expect([layerArp.left, layerArp.right]).toStrictEqual([bare.left, bare.right])
    }, 60000)

    it("two layers each get exactly the steps of the bare unit", async () => {
        const bare = await countSteps([])
        const layered = await countSteps([LEFT, RIGHT])
        console.log(`bare=${JSON.stringify(bare)} layered=${JSON.stringify(layered)}`)
        expect(layered.left).toBe(bare.left)
        expect(layered.right).toBe(bare.right)
    }, 60000)
})
