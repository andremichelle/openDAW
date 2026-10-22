import {AudioUnitType} from "@opendaw/studio-enums"
import {int, isDefined, Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, CaptureAudioBox, CaptureMidiBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitGroups} from "../audio-unit/AudioUnitGroups"
import {AudioUnitOrdering} from "./AudioUnitOrdering"
import {CaptureBox} from "../CaptureBox"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TrackType} from "../timeline/TrackType"

export namespace AudioUnitFactory {
    export const create = ({boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}}: ProjectSkeleton,
                           type: AudioUnitType,
                           capture: Option<CaptureBox>, index?: int, destination?: AudioBusBox): AudioUnitBox => {
        const insertIndex = index ?? AudioUnitFactory.orderAndGetIndex(rootBox, type)
        console.debug(`createAudioUnit type: ${type}, insertIndex: ${insertIndex}`)
        return AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer((destination ?? primaryAudioBusBox).input)
            box.index.setValue(insertIndex)
            box.type.setValue(type)
            capture.ifSome(capture => box.capture.refer(capture))
        })
    }

    export const orderAndGetIndex = (rootBox: RootBox, type: AudioUnitType): int => {
        const boxes = AudioUnitGroups.ordered(rootBox)
        const order = AudioUnitOrdering[type]
        let index = boxes.findIndex(box => !isDefined(AudioUnitGroups.parent(box))
            && AudioUnitOrdering[box.type.getValue()] > order)
        if (index < 0) {index = boxes.length}
        boxes.forEach((box, position) => box.index.setValue(position < index ? position : position + 1))
        return index
    }

    export const trackTypeToCapture = (boxGraph: BoxGraph, trackType: TrackType): Option<CaptureBox> => {
        switch (trackType) {
            case TrackType.Audio:
                return Option.wrap(CaptureAudioBox.create(boxGraph, UUID.generate()))
            case TrackType.Notes:
                return Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate()))
            default:
                return Option.None
        }
    }
}