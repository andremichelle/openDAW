import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers, TransientPlayMode} from "@moises-ai/studio-enums"

export const AudioTimeStretchBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioTimeStretchBox",
        fields: {
            1: {
                type: "field", name: "warp-markers",
                pointerRules: {accepts: [Pointers.WarpMarkers], mandatory: true}
            },
            2: {
                type: "int32", name: "transient-play-mode",
                constraints: "positive", unit: "enum", value: TransientPlayMode.Pingpong
            },
            3: {
                type: "float32", name: "playback-rate",
                constraints: "positive", unit: "ratio", value: 1.0
            }
        }
    }, pointerRules: {accepts: [Pointers.AudioPlayMode], mandatory: true}
}