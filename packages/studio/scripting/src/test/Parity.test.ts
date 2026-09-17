import {describe, expect, it} from "vitest"
import {ArrayField, Box, Field, ObjectField, PointerField, PrimitiveField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {createFixture} from "./Fixture"
import {Fields} from "../impl/Fields"
import {Facade} from "../impl/Common"
import {AudioEffects, Instruments, MIDIEffects} from "../Api"

const collectFields = (vertex: Box | Field, path: string, into: Array<[string, PrimitiveField<any, any>]>): void => {
    vertex.fields().forEach(field => {
        if (field.deprecated) {return}
        const name = path.length === 0 ? field.fieldName : `${path}.${field.fieldName}`
        if (field instanceof PrimitiveField) {
            into.push([name, field])
        } else if (field instanceof ObjectField || field instanceof ArrayField) {
            collectFields(field, name, into)
        }
    })
}

const boundFields = (facade: object): Set<PrimitiveField<any, any>> =>
    new Set(Fields.paths(facade).map(path => Fields.resolve(facade, path).unwrap()))

const structural = new Set(["index", "host", "version", "label", "icon", "enabled", "minimized", "code"])

const assertMirrored = (facade: object) => {
    const box = (facade as Facade).box
    const fields: Array<[string, PrimitiveField<any, any>]> = []
    collectFields(box, "", fields)
    const bound = boundFields(facade)
    const missingAutomatable = fields
        .filter(([, field]) => field.pointerRules.accepts.includes(Pointers.Automation) && !bound.has(field))
        .map(([name]) => name)
    expect(missingAutomatable, `${box.name} automatable fields not mirrored`).toEqual([])
    const missingPlain = fields
        .filter(([name, field]) => !bound.has(field) && !structural.has(name.split(".").pop() ?? name))
        .map(([name]) => name)
    return missingPlain
}

describe("Schema parity", () => {
    it("mirrors every automatable instrument parameter", () => {
        const {project} = createFixture()
        const keys: ReadonlyArray<keyof Instruments> = ["Vaporisateur", "Playfield", "Nano", "Soundfont", "MIDIOutput", "Tape", "Neon", "Cubed", "Apparat"]
        const plain: Record<string, ReadonlyArray<string>> = {}
        keys.forEach(key => {plain[key] = assertMirrored(project.addInstrumentUnit(key).instrument)})
        expect(plain).toEqual({
            Vaporisateur: [],
            Playfield: [],
            Nano: [],
            Soundfont: [],
            MIDIOutput: [],
            Tape: [],
            Neon: [],
            // patterns are exposed as CubedPattern objects (length + unpacked steps), not through the field binder
            Cubed: Array.from({length: 16}, (_, pattern) => [
                `patterns.${pattern}.length`,
                ...Array.from({length: 64}, (_, step) => `patterns.${pattern}.steps.${step}`)
            ]).flat(),
            Apparat: []
        })
    })

    it("mirrors every automatable midi effect parameter", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const keys: ReadonlyArray<keyof MIDIEffects> = ["Arpeggio", "Pitch", "Velocity", "Zeitgeist", "Spielwerk"]
        keys.forEach(key => expect(assertMirrored(unit.addMIDIEffect(key)), key).toEqual([]))
    })

    it("mirrors every automatable audio effect parameter", () => {
        const {project} = createFixture()
        const unit = project.addAuxUnit()
        const keys: ReadonlyArray<keyof AudioEffects> = [
            "Autotune", "Compressor", "Convolver", "Crusher", "DattorroReverb", "Delay", "Fold", "Gate", "Maximizer",
            "NeuralAmp", "Revamp", "Reverb", "StereoTool", "Tidal", "Vocoder", "Waveshaper", "Werkstatt",
            "Composite", "StereoSplit", "FrequencySplit"
        ]
        const plain: Record<string, ReadonlyArray<string>> = {}
        keys.forEach(key => {plain[key] = assertMirrored(unit.addAudioEffect(key))})
        expect(plain).toEqual({
            Autotune: [], Compressor: [], Convolver: [], Crusher: [], DattorroReverb: [], Delay: [], Fold: [],
            Gate: [], Maximizer: [], NeuralAmp: [], Revamp: [], Reverb: [], StereoTool: [], Tidal: [],
            Vocoder: ["modulatorSource"], Waveshaper: [], Werkstatt: [], Composite: [], StereoSplit: [], FrequencySplit: []
        })
    })

    it("mirrors playfield slots, composite entries, sends, modulators, units and timeline objects", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Playfield")
        const slot = unit.instrument.addSample({uuid: "0aab1f52-7d7a-4f0b-9c2d-3e6f7a8b9c0d", name: "x", duration: 1, bpm: 0, sample_rate: 1})
        expect(assertMirrored(slot)).toEqual([])
        const entry = unit.addAudioEffect("Composite").addEntry()
        expect(assertMirrored(entry)).toEqual([])
        const send = unit.addSend(project.addAuxUnit())
        expect(assertMirrored(send)).toEqual(["routing"])
        expect(assertMirrored(unit)).toEqual(["type", "userInterface.automationCollapsed"])
        expect(assertMirrored(project.addModulator("LFO"))).toEqual([])
        expect(assertMirrored(project.addModulator("Steps"))).toEqual([])
        expect(assertMirrored(project.addModulator("Random"))).toEqual([])
        expect(assertMirrored(project.addModulator("Macro"))).toEqual([])
        const region = unit.noteTracks[0].addRegion()
        expect(assertMirrored(region)).toEqual([])
        expect(assertMirrored(region.addEvent())).toEqual([])
        const clip = unit.noteTracks[0].addClip()
        expect(assertMirrored(clip)).toEqual([])
        expect(assertMirrored(project.addMarker())).toEqual([])
        expect(assertMirrored(project.groove)).toEqual([])
        const value = unit.addValueTrack(unit, "volume")
        expect(assertMirrored(value)).toEqual(["type"])
        const valueRegion = value.addRegion()
        expect(assertMirrored(valueRegion)).toEqual([])
        expect(assertMirrored(valueRegion.addEvent())).toEqual(["interpolation"])
    })
})
