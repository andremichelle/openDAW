import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Box, Field, PrimitiveField} from "@opendaw/lib-box"
import {Devices, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {EffectFactories} from "./EffectFactories"
import type {ProjectEnv} from "./project/ProjectEnv"
import type {Project} from "./project/Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const SkippedInstruments: ReadonlyArray<string> = ["InstrumentComposite", "MIDIOutput", "Playfield", "Soundfont", "Tape", "Wclap"]
const SkippedEffects: ReadonlyArray<string> = ["Wclap", "WclapMidi"]

const primitiveFields = (fields: ReadonlyArray<Field>, result: Array<PrimitiveField>): Array<PrimitiveField> => {
    fields.forEach(field => field.accept({
        visitArrayField: field => primitiveFields(field.fields(), result),
        visitObjectField: field => primitiveFields(field.fields(), result),
        visitPrimitiveField: (field: PrimitiveField) => {result.push(field)}
    }))
    return result
}

const resetValues = (project: Project, boxes: ReadonlyArray<Box>): Map<string, unknown> => {
    const values = new Map<string, unknown>()
    boxes.forEach(box => {
        project.boxAdapters.adapterFor(box, Devices.isAny)
        primitiveFields(box.fields(), []).forEach(field => project.parameterFieldAdapters.opt(field.address)
            .ifSome(parameter => values.set(`${box.name} ${parameter.name} ${field.address.toString()}`, parameter.resetValue)))
    })
    return values
}

const float32 = (value: unknown): unknown => typeof value === "number" ? Math.fround(value) : value

// live error 1206: a parameter must reset to the same value whether its box was just created or loaded
describe("parameter reset value parity between fresh and loaded devices", () => {
    it("every stock instrument and effect resets to the same value after a reload", async () => {
        const {Project} = await import("./project/Project")
        const fresh = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const boxes = fresh.editing.modify(() => {
            const created: Array<Box> = []
            Object.entries(InstrumentFactories.Named)
                .filter(([key]) => !SkippedInstruments.includes(key))
                .forEach(([, factory]) => {
                    const {instrumentBox, audioUnitBox} = fresh.api.createAnyInstrument(factory)
                    created.push(instrumentBox)
                    Object.entries(EffectFactories.MergedNamed)
                        .filter(([key]) => !SkippedEffects.includes(key))
                        .forEach(([, effect]) => {
                            if (factory !== InstrumentFactories.Vaporisateur) {return}
                            const field = effect.type === "audio" ? audioUnitBox.audioEffects : audioUnitBox.midiEffects
                            created.push(fresh.api.insertEffect(field, effect))
                        })
                })
            return created
        }).unwrap("setup")
        const before = resetValues(fresh, boxes)
        const loaded = Project.load(createEnv(), fresh.toArrayBuffer() as ArrayBuffer)
        const after = resetValues(loaded, boxes.map(box => loaded.boxGraph.findBox(box.address.uuid).unwrap()))
        expect(before.size).toBeGreaterThan(100)
        const mismatches = Array.from(before.entries())
            .filter(([key, value]) => !Object.is(float32(after.get(key)), float32(value)))
            .map(([key, value]) => `${key}: fresh ${value}, loaded ${after.get(key)}`)
        expect(mismatches).toEqual([])
    })
})
