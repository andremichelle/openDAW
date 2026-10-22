import {AudioUnitType} from "@opendaw/studio-enums"
import {int, Option, UUID} from "@opendaw/lib-std"
import {BoxGraph, IndexedBox} from "@opendaw/lib-box"
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
        const boxes = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const order: int = AudioUnitOrdering[type]
        let index = 0 | 0
        for (; index < boxes.length; index++) {
            if (!AudioUnitGroups.parent(boxes[index]) && (boxes[index].isGroup.getValue() || AudioUnitOrdering[boxes[index].type.getValue()] > order)) {break}
        }
        const insertIndex = index
        while (index < boxes.length) {
            boxes[index].index.setValue(++index)
        }
        return insertIndex
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