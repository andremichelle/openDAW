import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBusFactory, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, AuxSendBox, CaptureMidiBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioSendRouting, AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"

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
    const reverb = AudioBusFactory.create(skeleton, "Reverb", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)
    const delay = AudioBusFactory.create(skeleton, "Delay", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)
    const sendBox = AuxSendBox.create(boxGraph, UUID.generate(), box => {
        box.audioUnit.refer(audioUnitBox.auxSends)
        box.targetBus.refer(reverb.input)
        box.routing.setValue(AudioSendRouting.Post)
        box.index.setValue(0)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    const addLane = (field: AuxSendBox["sendGain"] | AuxSendBox["sendPan"]): TrackBoxAdapter =>
        project.editing.modify(() => {
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(audioUnitBox.tracks.pointerHub.incoming().length)
                box.target.refer(field)
                box.type.setValue(TrackType.Value)
                box.tracks.refer(audioUnitBox.tracks)
            })
            return project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        }).unwrap("send-lane")
    return {project, sendBox, reverb, delay, addLane}
}

const pathOf = (track: TrackBoxAdapter): Option<[string, string]> => {
    let path: Option<[string, string]> = Option.None
    track.catchupAndSubscribePath(option => path = option).terminate()
    return path
}

describe("aux send automation lanes", () => {
    it("names each lane after the send's target bus", async () => {
        const {sendBox, addLane} = await setup()
        expect(pathOf(addLane(sendBox.sendGain)).unwrap()).toEqual(["Send Reverb", "gain"])
        expect(pathOf(addLane(sendBox.sendPan)).unwrap()).toEqual(["Send Reverb", "panning"])
    })

    it("names the static target name the same way", async () => {
        const {sendBox, addLane} = await setup()
        expect(addLane(sendBox.sendGain).targetName.unwrap()).toBe("Send Reverb")
    })

    it("follows a bus rename and a rewire", async () => {
        const {project, sendBox, reverb, delay, addLane} = await setup()
        const track = addLane(sendBox.sendGain)
        const captured: Array<string> = []
        const subscription = track.catchupAndSubscribePath(option =>
            option.ifSome(([device]) => {if (captured.at(-1) !== device) {captured.push(device)}}))
        project.editing.modify(() => reverb.label.setValue("Hall"))
        project.editing.modify(() => sendBox.targetBus.refer(delay.input))
        subscription.terminate()
        expect(captured).toEqual(["Send Reverb", "Send Hall", "Send Delay"])
    })
})
