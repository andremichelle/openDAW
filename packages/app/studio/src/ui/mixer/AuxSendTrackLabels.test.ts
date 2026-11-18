import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    AudioBusFactory,
    AudioUnitBoxAdapter,
    AuxSendBoxAdapter,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
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
    const reverb = AudioBusFactory.create(skeleton, "Reverb", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)
    const delay = AudioBusFactory.create(skeleton, "Delay", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)
    const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
    const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.capture.refer(capture)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(3)
    })
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
    const send = project.boxAdapters.adapterFor(sendBox, AuxSendBoxAdapter)
    const unit = project.boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter)
    const automate = (field: AuxSendBox["sendGain"]): TrackBoxAdapter => project.editing.modify(() => {
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(audioUnitBox.tracks.pointerHub.incoming().length)
            box.target.refer(field)
            box.type.setValue(TrackType.Value)
            box.tracks.refer(audioUnitBox.tracks)
        })
        return project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    }).unwrap("send-track")
    return {project, reverb, delay, sendBox, send, unit, automate}
}

const pathOf = (track: TrackBoxAdapter): Option<[string, string]> => {
    let path: Option<[string, string]> = Option.None
    track.catchupAndSubscribePath(option => path = option).terminate()
    return path
}

describe("Aux send automation lanes", () => {
    it("names gain and pan lanes after the target bus", async () => {
        const {sendBox, automate} = await setup()
        expect(pathOf(automate(sendBox.sendGain)).unwrap()).toEqual(["Send Reverb", "Gain"])
        expect(pathOf(automate(sendBox.sendPan)).unwrap()).toEqual(["Send Reverb", "Panning"])
    })

    it("follows a bus rename and a rewire", async () => {
        const {project, reverb, delay, sendBox, automate} = await setup()
        const track = automate(sendBox.sendGain)
        const captured: Array<string> = []
        const subscription = track.catchupAndSubscribePath(option =>
            option.ifSome(([owner]) => captured.push(owner)))
        project.editing.modify(() => reverb.label.setValue("Hall"))
        project.editing.modify(() => sendBox.targetBus.refer(delay.input))
        subscription.terminate()
        expect(captured.filter((name, index) => captured.indexOf(name) === index))
            .toEqual(["Send Reverb", "Send Hall", "Send Delay"])
        expect(track.targetName.unwrap()).toEqual("Send Delay")
    })

    it("resolves the lane owner to the sending audio unit", async () => {
        const {send, unit, automate, sendBox} = await setup()
        expect(send.sendGain.optTracks().unwrap()).toBe(unit.tracks)
        expect(send.sendPan.optTracks().unwrap()).toBe(unit.tracks)
        const track = automate(sendBox.sendGain)
        expect(send.sendGain.track.unwrap()).toBe(track)
    })
})
