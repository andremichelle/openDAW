import {IconSymbol} from "@moises-ai/studio-enums"

export enum TrackType {Undefined, Notes, Audio, Value}

export namespace TrackType {
    export const toLabelString = (type: TrackType): string => {
        switch (type) {
            case TrackType.Audio:
                return "Audio"
            case TrackType.Notes:
                return "Notes"
            case TrackType.Value:
                return "Automation"
            case TrackType.Undefined:
            default:
                return "N/A"
        }
    }
    export const toIconSymbol = (type: TrackType) => {
        switch (type) {
            case TrackType.Audio:
                return IconSymbol.Waveform
            case TrackType.Notes:
                return IconSymbol.Piano
            case TrackType.Value:
                return IconSymbol.Automation
            case TrackType.Undefined:
                return IconSymbol.AudioBus
            default:
                return IconSymbol.Unknown
        }
    }
}