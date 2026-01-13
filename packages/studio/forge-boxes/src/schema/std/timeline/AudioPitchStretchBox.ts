import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const AudioPitchStretchBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioPitchStretchBox",
        fields: {
            1: {
                type: "field", name: "warp-markers", pointerRules: {accepts: [Pointers.WarpMarkers], mandatory: true}
            }
        }
    }, pointerRules: {accepts: [Pointers.AudioPlayMode], mandatory: true}
}