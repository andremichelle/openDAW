import {asInstanceOf, clamp} from "@opendaw/lib-std"
import {MaxTrackHeight} from "@opendaw/studio-enums"
import {AudioBusBox, AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "./StudioPreferences"

export namespace TrackHeightDefaults {
    export const minimum = 48
    export const normalize = (value: number): number =>
        Number.isFinite(value) ? clamp(Math.round(value), minimum, MaxTrackHeight) : minimum
    // Internal persisted state: only completed track resizing changes the remembered height.
    export const get = (): number => normalize(StudioPreferences.settings.timeline["default-track-height"])
    export const remember = (height: number): void => {
        StudioPreferences.settings.timeline["default-track-height"] = normalize(height)
    }
    export const apply = (track: TrackBox): TrackBox => {
        track.height.setValue(get())
        return track
    }
    export const applyBus = (bus: AudioBusBox): void => {
        asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox).userInterface.height.setValue(get())
    }
}
