// Scripts read the project key and chord through this.keyAt / this.chordAt. The Apparat script encodes what it reads
// as DC: left = key root / 100 + number of steps / 1000, right = chord root / 100 + sum of chord notes / 10000.
import {describe, expect, it} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {Harmony} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, ChordEventBox, KeyEventBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const INSTRUMENT = `class Processor {
    process(output, block) {
        const [l, r] = output
        const key = this.keyAt(block.p0)
        const chord = this.chordAt(block.p0)
        const left = key.root / 100 + key.steps.length / 1000
        const right = chord === null ? 0 : chord.root / 100 + chord.notes.reduce((sum, note) => sum + note, 0) / 10000
        for (let i = block.s0; i < block.s1; i++) { l[i] += left; r[i] += right }
    }
}`

type Chord = { position: number, duration: number, degree: number, inversion?: number }
type Settings = { keyRoot?: number, keyBits?: number, chords?: ReadonlyArray<Chord> }

const render = async ({keyRoot, keyBits, chords}: Settings, quanta: ReadonlyArray<number>) => {
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
    if (isDefined(keyRoot)) {
        KeyEventBox.create(source, UUID.generate(), box => {
            box.track.refer(timelineBox.keyTrack.events)
            box.position.setValue(0)
            box.root.setValue(keyRoot)
            box.scale.setValue(keyBits ?? Harmony.MajorBits)
        })
    }
    ;(chords ?? []).forEach(({position, duration, degree, inversion}) => ChordEventBox.create(source, UUID.generate(), box => {
        box.track.refer(timelineBox.chordTrack.events)
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.degree.setValue(degree)
        box.inversion.setValue(inversion ?? 0)
    }))
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, INSTRUMENT))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const half = (engine.output_len() >>> 0) >>> 1
    let rendered = 0
    const result = quanta.map(quantum => {
        let frame: [number, number] = [0, 0]
        while (rendered < quantum) {
            engine.render()
            rendered++
            const output = new Float32Array(memory.buffer, engine.output_ptr(), half << 1)
            frame = [output[half - 1], output[(half << 1) - 1]]
        }
        return frame
    })
    sync.close()
    return result
}

describe("scripts read the key and chord", () => {
    it("reads the project key and no chord by default", async () => {
        const [[left, right]] = await render({}, [50])
        expect(left).toBeCloseTo(0.007, 6)
        expect(right).toBe(0)
    }, 60000)
    it("reads the key track and the chord on it", async () => {
        const [[left, right]] = await render({keyRoot: 2, chords: [{position: 0, duration: 3840, degree: 5}]}, [50])
        expect(left).toBeCloseTo(0.027, 6)
        expect(right).toBeCloseTo(0.0911, 6)
    }, 60000)
    it("reads the inversion and the next chord", async () => {
        const [[, first], [, second]] = await render({chords: [
            {position: 0, duration: 960, degree: 1, inversion: 1},
            {position: 960, duration: 2880, degree: 6}
        ]}, [50, 250])
        expect(first).toBeCloseTo(0.0023, 6)
        expect(second).toBeCloseTo(0.0910, 6)
    }, 60000)
    it("reads a pentatonic key without chords", async () => {
        const [[left, right]] = await render({keyRoot: 9, keyBits: 0b001010010101, chords: [{position: 0, duration: 3840, degree: 1}]}, [50])
        expect(left).toBeCloseTo(0.095, 6)
        expect(right).toBe(0)
    }, 60000)
})
