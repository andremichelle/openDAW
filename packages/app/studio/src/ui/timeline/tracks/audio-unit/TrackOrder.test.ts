import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentCompositeBox, DelayDeviceBox, PitchDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton, TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "@opendaw/studio-core"
import {TrackOrder} from "./TrackOrder"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined, sampleService: undefined,
    soundfontService: undefined,
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
    }
}) as unknown as ProjectEnv

// The automation lanes of one unit sort like the device panel reads: midi fx, instrument, audio fx. A device
// inside a LAYER sorts right after the composite, layer by layer, and inside a layer in that same kind order.
describe("TrackOrder", () => {
    it("sorts the lanes of devices inside instrument layers", async () => {
        const {EffectFactories, Project} = await import("@opendaw/studio-core") // after the AudioWorkletNode shim
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {api, boxGraph, boxAdapters} = project
        const lanes = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox, trackBox} = api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const layerA = api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const layerB = api.createCompositeLayer(composite, InstrumentFactories.Nano).result()
            const layerPitch = api.insertEffect(layerA.cellBox.midiEffects, EffectFactories.MidiNamed.Pitch) as PitchDeviceBox
            const layerDelay = api.insertEffect(layerA.cellBox.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const unitDelay = api.insertEffect(audioUnitBox.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const unitPitch = api.insertEffect(audioUnitBox.midiEffects, EffectFactories.MidiNamed.Pitch) as PitchDeviceBox
            // Created in a deliberately WRONG order, the key must sort them.
            return {
                "unit delay": api.createAutomationTrack(audioUnitBox, unitDelay.feedback),
                "layer B synth": api.createAutomationTrack(audioUnitBox, layerB.instrumentBox.volume),
                "layer A delay": api.createAutomationTrack(audioUnitBox, layerDelay.feedback),
                "layer A strip": api.createAutomationTrack(audioUnitBox, layerA.cellBox.gain),
                "layer A synth": api.createAutomationTrack(audioUnitBox, layerA.instrumentBox.cutoff),
                "unit pitch": api.createAutomationTrack(audioUnitBox, unitPitch.cents),
                "layer A pitch": api.createAutomationTrack(audioUnitBox, layerPitch.cents),
                "notes": trackBox
            } satisfies Record<string, TrackBox>
        }).unwrap()
        const sorted = Object.entries(lanes)
            .map(([name, box]) => ({name, key: TrackOrder.keyOf(boxAdapters, boxAdapters.adapterFor(box, TrackBoxAdapter))}))
            .toSorted((a, b) => TrackOrder.compare(a.key, b.key))
            .map(({name}) => name)
        expect(sorted).toStrictEqual(["notes", "unit pitch",
            "layer A strip", "layer A pitch", "layer A synth", "layer A delay", "layer B synth", "unit delay"])
        expect(boxGraph.boxes().length).toBeGreaterThan(0)
        project.terminate()
    })
})
