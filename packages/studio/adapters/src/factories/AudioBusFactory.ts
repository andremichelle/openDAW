import {AudioUnitType, IconSymbol} from "@moises-ai/studio-enums"
import {AudioBusBox, TrackBox} from "@moises-ai/studio-boxes"
import {assert, Color, Option, UUID} from "@moises-ai/lib-std"
import {AudioUnitFactory} from "./AudioUnitFactory"
import {TrackType} from "../timeline/TrackType"
import {ProjectSkeleton} from "../project/ProjectSkeleton"

export namespace AudioBusFactory {
    export const create = (skeleton: ProjectSkeleton,
                           name: string,
                           icon: IconSymbol,
                           type: AudioUnitType,
                           color: Color): AudioBusBox => {
        console.debug(`createAudioBus '${name}', type: ${type}, color: ${color}`)
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        assert(rootBox.isAttached(), "rootBox not attached")
        const uuid = UUID.generate()
        const audioBusBox = AudioBusBox.create(boxGraph, uuid, box => {
            box.collection.refer(rootBox.audioBusses)
            box.label.setValue(name)
            box.icon.setValue(IconSymbol.toName(icon))
            box.color.setValue(color.toString())
        })
        const audioUnitBox = AudioUnitFactory.create(skeleton, type, Option.None)
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
            box.index.setValue(0)
            box.type.setValue(TrackType.Undefined)
        })
        audioBusBox.output.refer(audioUnitBox.input)
        return audioBusBox
    }
}