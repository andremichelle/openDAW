import {BoxSchema, deprecated} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {TimeBase} from "@moises-ai/lib-dsp"
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
            17: {type: "float32", name: "gain", constraints: "decibel", unit: "db"}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.Editing, Pointers.MetaData], mandatory: false}
}