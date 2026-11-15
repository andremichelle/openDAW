import {int} from "@opendaw/lib-std"

export namespace MixerDeviceRows {
    export const MaxMidiEffectRows: int = 5
    export const MaxAudioEffectRows: int = 5

    export const maxRowsOf = (kind: "midi" | "audio"): int => kind === "midi" ? MaxMidiEffectRows : MaxAudioEffectRows
}
