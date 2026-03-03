import {AudioBusBox, AudioUnitBox, RootBox, TimelineBox, UserInterfaceBox} from "@moises-ai/studio-boxes"

export type ProjectMandatoryBoxes = {
    rootBox: RootBox
    timelineBox: TimelineBox
    primaryAudioBusBox: AudioBusBox
    primaryAudioUnitBox: AudioUnitBox
    userInterfaceBoxes: ReadonlyArray<UserInterfaceBox>
}