import {BoxSchema, deprecated} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ClipTriggerFields} from "./ClipTriggerFields"
import {HueConstraints} from "../Defaults"
import {TimeBase} from "@opendaw/lib-dsp"

export const AudioClipBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioClipBox",
        fields: {
            1: {type: "pointer", name: "clips", pointerType: Pointers.ClipCollection, mandatory: true},
            2: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: true},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "object", name: "trigger-mode", class: ClipTriggerFields},
            5: {type: "pointer", name: "events", pointerType: Pointers.ValueEventCollection, mandatory: true},
            6: {type: "pointer", name: "warping", pointerType: Pointers.Deprecated, mandatory: false, deprecated},
            7: {type: "float32", name: "waveform-offset", constraints: "any", unit: "seconds"},
            8: {type: "pointer", name: "play-mode", pointerType: Pointers.AudioPlayMode, mandatory: false},
            10: {type: "float32", name: "duration", constraints: "any", unit: "ppqn"},
            11: {type: "boolean", name: "mute"},
            12: {type: "string", name: "label"},
            13: {type: "int32", name: "hue", ...HueConstraints},
            14: {type: "float32", name: "gain", constraints: "decibel", unit: "db"},
            20: {type: "string", name: "playback", deprecated},
            21: {type: "string", name: "time-base", value: TimeBase.Musical}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.Editing, Pointers.MetaData], mandatory: false}
}