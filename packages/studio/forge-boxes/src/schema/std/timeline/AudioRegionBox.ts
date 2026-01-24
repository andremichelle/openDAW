import {BoxSchema, deprecated} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {TimeBase} from "@opendaw/lib-dsp"
import {HueConstraints, PPQNPositionConstraints} from "../Defaults"

export const AudioRegionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioRegionBox",
        fields: {
            1: {type: "pointer", name: "regions", pointerType: Pointers.RegionCollection, mandatory: true},
            2: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: true},
            3: {type: "string", name: "playback", deprecated},
            4: {type: "string", name: "time-base", value: TimeBase.Musical},
            5: {type: "pointer", name: "events", pointerType: Pointers.ValueEventCollection, mandatory: true},
            6: {type: "pointer", name: "warping", pointerType: Pointers.Deprecated, mandatory: false, deprecated},
            7: {type: "float32", name: "waveform-offset", constraints: "any", unit: "seconds"},
            8: {type: "pointer", name: "play-mode", pointerType: Pointers.AudioPlayMode, mandatory: false},
            10: {type: "int32", name: "position", ...PPQNPositionConstraints},
            11: {type: "float32", name: "duration", constraints: "any", unit: "mixed"},
            12: {type: "float32", name: "loop-offset", constraints: "any", unit: "mixed"},
            13: {type: "float32", name: "loop-duration", constraints: "any", unit: "mixed"},
            14: {type: "boolean", name: "mute"},
            15: {type: "string", name: "label"},
            16: {type: "int32", name: "hue", ...HueConstraints},
            17: {type: "float32", name: "gain", constraints: "decibel", unit: "db"},
            18: {
                type: "object", name: "fading", class: {
                    name: "Fading",
                    fields: {
                        1: {type: "float32", name: "in", value: 0.0, constraints: "unipolar", unit: "ratio"},
                        2: {type: "float32", name: "out", value: 1.0, constraints: "unipolar", unit: "ratio"},
                        3: {type: "float32", name: "in-slope", value: 0.5, constraints: "unipolar", unit: "ratio"},
                        4: {type: "float32", name: "out-slope", value: 0.5, constraints: "unipolar", unit: "ratio"}
                    }
                }
            }
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.Editing, Pointers.MetaData], mandatory: false}
}