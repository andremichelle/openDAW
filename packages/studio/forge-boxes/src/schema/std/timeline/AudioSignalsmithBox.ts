import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// A timeline audio play-mode backed by the Signalsmith phase-vocoder (spectral time-stretch +
// independent pitch). Parallel to AudioTimeStretchBox but WITHOUT transient markers/play-modes —
// the phase vocoder needs none; it follows the warp markers and shifts pitch spectrally.
export const AudioSignalsmithBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioSignalsmithBox",
        fields: {
            1: {
                type: "field", name: "warp-markers",
                pointerRules: {accepts: [Pointers.WarpMarkers], mandatory: true}
            },
            2: {
                type: "float32", name: "transpose",
                constraints: {min: -24.0, max: 24.0, scaling: "linear"}, unit: "st", value: 0.0
            }
        }
    }, pointerRules: {accepts: [Pointers.AudioPlayMode], mandatory: true}
}
