import {AudioBusBox, AudioUnitBox, RootBox, TimelineBox, UserInterfaceBox} from "@moises-ai/studio-boxes"

export type ProjectMandatoryBoxes = {
    rootBox: RootBox
    timelineBox: TimelineBox
    primaryAudioBus: AudioBusBox
    primaryAudioOutputUnit: AudioUnitBox
    userInterfaceBoxes: ReadonlyArray<UserInterfaceBox>
}