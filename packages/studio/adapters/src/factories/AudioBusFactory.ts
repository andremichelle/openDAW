import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {AudioBusBox} from "@opendaw/studio-boxes"
import {assert, Color, Option, UUID} from "@opendaw/lib-std"
import {AudioUnitFactory} from "./AudioUnitFactory"
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
        audioBusBox.output.refer(audioUnitBox.input)
        return audioBusBox
    }
}