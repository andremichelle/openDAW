import {describe, expect, it} from "vitest"
import {asInstanceOf, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, CompressorDeviceBox, WerkstattDeviceBox, WerkstattSidechainBox} from "@opendaw/studio-boxes"
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

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./project/Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

describe("AudioUnitFreeze.hasSidechainDependents", () => {
    const setup = async () => {
        const project = await createProject()
        const {api} = project
        const units = project.editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Apparat)
            const consumer = api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const werkstatt = asInstanceOf(api.insertEffect(consumer.audioUnitBox.audioEffects,
                EffectFactories.AudioNamed.Werkstatt), WerkstattDeviceBox)
            return {
                sourceUnit: source.audioUnitBox, tone: asInstanceOf(source.instrumentBox, ApparatDeviceBox),
                consumerUnit: consumer.audioUnitBox, werkstatt
            }
        }).unwrap("setup")
        const sourceAdapter = project.boxAdapters.adapterFor(units.sourceUnit, AudioUnitBoxAdapter)
        return {project, sourceAdapter, ...units}
    }

    it("is false when nothing taps the unit", async () => {
        const {project, sourceAdapter} = await setup()
        expect(project.audioUnitFreeze.hasSidechainDependents(sourceAdapter)).toBe(false)
    })

    it("sees a Werkstatt @sidechain box tapping the unit's instrument", async () => {
        const {project, sourceAdapter, tone, werkstatt} = await setup()
        const sidechain = project.editing.modify(() => WerkstattSidechainBox.create(project.boxGraph, UUID.generate(), box => {
            box.owner.refer(werkstatt.sideChains)
            box.label.setValue("Key")
            box.index.setValue(0)
            box.source.refer(tone)
        })).unwrap("sidechain")
        expect(project.audioUnitFreeze.hasSidechainDependents(sourceAdapter)).toBe(true)
        project.editing.modify(() => sidechain.source.defer())
        expect(project.audioUnitFreeze.hasSidechainDependents(sourceAdapter)).toBe(false)
    })

    it("sees an Apparat @sidechain box tapping the unit's channel strip", async () => {
        const {project, sourceAdapter, sourceUnit} = await setup()
        project.editing.modify(() => {
            const apparat = asInstanceOf(project.api.createAnyInstrument(InstrumentFactories.Apparat).instrumentBox, ApparatDeviceBox)
            WerkstattSidechainBox.create(project.boxGraph, UUID.generate(), box => {
                box.owner.refer(apparat.sideChains)
                box.label.setValue("In")
                box.index.setValue(0)
                box.source.refer(sourceUnit)
            })
        })
        expect(project.audioUnitFreeze.hasSidechainDependents(sourceAdapter)).toBe(true)
    })

    it("still sees a Compressor sidechain", async () => {
        const {project, sourceAdapter, tone, consumerUnit} = await setup()
        project.editing.modify(() => asInstanceOf(project.api.insertEffect(consumerUnit.audioEffects,
            EffectFactories.AudioNamed.Compressor), CompressorDeviceBox).sideChain.refer(tone))
        expect(project.audioUnitFreeze.hasSidechainDependents(sourceAdapter)).toBe(true)
    })
})
