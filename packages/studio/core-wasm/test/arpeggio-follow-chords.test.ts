// Arpeggio following the project's chord track in the full engine. The instrument is an Apparat script that outputs
// DC pitch / 1000 per held voice, so the rendered level tells which key sounds (0 = nothing sounds).
import {describe, expect, it} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {Harmony} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, ChordEventBox, KeyEventBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const INSTRUMENT = `class Processor {
    voices = new Map()
    noteOn(pitch, velocity, cent, id) { this.voices.set(id, pitch) }
    noteOff(id) { this.voices.delete(id) }
    process(output, block) {
        const [l, r] = output
        let level = 0
        for (const pitch of this.voices.values()) { level += pitch / 1000 }
        for (let i = block.s0; i < block.s1; i++) { l[i] += level; r[i] += level }
    }
}`

type Chord = { position: number, duration: number, degree: number }
type Settings = { follow?: boolean, chords?: ReadonlyArray<Chord>, keyRoot?: number }

// rate 1/4 = 960 pulses = 0.5s at 120 bpm = 187.5 quanta of 128 frames, gate 1
const RATE_QUARTER = 3
const STEP_QUANTA = [50, 250, 450] as const

const createScene = async ({follow, chords, keyRoot}: Settings) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + INSTRUMENT)
    })
    const arpeggio = ArpeggioDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.rateIndex.setValue(RATE_QUARTER)
        box.followChords.setValue(follow ?? true)
    })
    if (isDefined(keyRoot)) {
        KeyEventBox.create(source, UUID.generate(), box => {
            box.track.refer(timelineBox.keyTrack.events)
            box.position.setValue(0)
            box.root.setValue(keyRoot)
            box.scale.setValue(Harmony.MajorBits)
        })
    }
    const chordBoxes = (chords ?? []).map(({position, duration, degree}) => ChordEventBox.create(source, UUID.generate(), box => {
        box.track.refer(timelineBox.chordTrack.events)
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.degree.setValue(degree)
    }))
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, INSTRUMENT))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    let rendered = 0
    const levelAt = (quantum: number): number => {
        let last = 0
        while (rendered < quantum) {
            engine.render()
            rendered++
            last = new Float32Array(memory.buffer, engine.output_ptr(), half)[half - 1]
        }
        return last
    }
    const edit = async (modify: () => void): Promise<void> => {
        source.beginTransaction(); modify(); source.endTransaction()
        await sync.settle()
    }
    engine.stop(); engine.play()
    return {arpeggio, chordBoxes, levelAt, edit, close: () => sync.close()}
}

const levels = async (settings: Settings): Promise<ReadonlyArray<number>> => {
    const scene = await createScene(settings)
    const result = STEP_QUANTA.map(quantum => scene.levelAt(quantum))
    scene.close()
    return result
}

describe("Arpeggio follows the chord track", () => {
    it("plays the chord of the step without held keys", async () => {
        const result = await levels({chords: [{position: 0, duration: 3840, degree: 5}]})
        expect(result[0]).toBeCloseTo(0.067, 6)
        expect(result[1]).toBeCloseTo(0.071, 6)
        expect(result[2]).toBeCloseTo(0.074, 6)
    }, 60000)
    it("resolves the degree against the key track", async () => {
        const result = await levels({keyRoot: 2, chords: [{position: 0, duration: 3840, degree: 1}]})
        expect(result[0]).toBeCloseTo(0.062, 6)
        expect(result[1]).toBeCloseTo(0.066, 6)
        expect(result[2]).toBeCloseTo(0.069, 6)
    }, 60000)
    it("changes with the next chord", async () => {
        const result = await levels({chords: [{position: 0, duration: 960, degree: 1}, {position: 960, duration: 2880, degree: 6}]})
        expect(result[0]).toBeCloseTo(0.060, 6)
        expect(result[1]).toBeCloseTo(0.072, 6)
    }, 60000)
    it("stays silent without chords and held keys", async () => {
        expect(await levels({chords: []})).toEqual([0, 0, 0])
    }, 60000)
    it("ignores the chord track when switched off", async () => {
        expect(await levels({follow: false, chords: [{position: 0, duration: 3840, degree: 5}]})).toEqual([0, 0, 0])
    }, 60000)
    it("picks up a degree edit on the next step", async () => {
        const scene = await createScene({chords: [{position: 0, duration: 3840, degree: 1}]})
        expect(scene.levelAt(50)).toBeCloseTo(0.060, 6)
        await scene.edit(() => scene.chordBoxes[0].degree.setValue(4))
        expect(scene.levelAt(250)).toBeCloseTo(0.069, 6)
        scene.close()
    }, 60000)
})
