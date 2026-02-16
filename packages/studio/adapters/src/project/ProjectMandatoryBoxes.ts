import {AudioBusBox, AudioUnitBox, RootBox, TimelineBox, UserInterfaceBox} from "@opendaw/studio-boxes"

export type ProjectMandatoryBoxes = {
    rootBox: RootBox
    timelineBox: TimelineBox
    primaryAudioBusBox: AudioBusBox
    primaryAudioUnitBox: AudioUnitBox
    userInterfaceBoxes: ReadonlyArray<UserInterfaceBox>
}