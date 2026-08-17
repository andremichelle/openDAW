import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    CaptureMidiBox,
    MIDIOutputDeviceBox,
    MIDIOutputParameterBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const setup = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    boxGraph.beginTransaction()
    const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
    const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.capture.refer(capture)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const deviceBox = MIDIOutputDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue("MIDIOutput")
        box.host.refer(audioUnitBox.input)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    const addParameter = (controller: number): {track: TrackBoxAdapter, parameterBox: MIDIOutputParameterBox} =>
        project.editing.modify(() => {
            const parameterBox = MIDIOutputParameterBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("CC")
                box.owner.refer(deviceBox.parameters)
                box.controller.setValue(controller)
            })
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(audioUnitBox.tracks.pointerHub.incoming().length)
                box.target.refer(parameterBox.value)
                box.type.setValue(TrackType.Value)
                box.tracks.refer(audioUnitBox.tracks)
            })
            return {track: project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter), parameterBox}
        }).unwrap("cc-track")
    return {project, addParameter}
}

const pathOf = (track: TrackBoxAdapter): Option<[string, string]> => {
    let path: Option<[string, string]> = Option.None
    track.catchupAndSubscribePath(option => path = option).terminate()
    return path
}

describe("MIDI output CC tracks", () => {
    it("names each lane after its label and controller", async () => {
        const {addParameter} = await setup()
        expect(pathOf(addParameter(64).track).unwrap()).toEqual(["MIDIOutput", "CC 64"])
        expect(pathOf(addParameter(65).track).unwrap()).toEqual(["MIDIOutput", "CC 65"])
    })

    it("falls back to the controller when the label is empty", async () => {
        const {project, addParameter} = await setup()
        const {track, parameterBox} = addParameter(64)
        project.editing.modify(() => parameterBox.label.setValue(""))
        expect(pathOf(track).unwrap()).toEqual(["MIDIOutput", "64"])
    })

    it("follows a rename and a controller change", async () => {
        const {project, addParameter} = await setup()
        const {track, parameterBox} = addParameter(64)
        const captured: Array<string> = []
        const subscription = track.catchupAndSubscribePath(option =>
            option.ifSome(([_device, control]) => captured.push(control)))
        project.editing.modify(() => parameterBox.label.setValue("Cutoff"))
        project.editing.modify(() => parameterBox.controller.setValue(74))
        subscription.terminate()
        expect(captured).toEqual(["CC 64", "Cutoff 64", "Cutoff 74"])
    })
})
