import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints, MidiNoteConstraints, UnipolarConstraints} from "../../std/Defaults"

const Velocity = {constraints: {min: 1, max: 127}, unit: ""} as const
const Frames = {constraints: {min: 0, max: 0x7FFFFFFF}, unit: "frames"} as const

// One sample with the keys and velocities it plays on. Positions are frames, so imported loops stay exact.
export const SamplerZoneBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SamplerZoneBox",
        fields: {
            1: {type: "pointer", name: "device", pointerType: Pointers.SamplerZone, mandatory: true},
            2: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: true},
            3: {type: "pointer", name: "group", pointerType: Pointers.SamplerGroupZone, mandatory: true},
            4: {type: "int32", name: "index", ...IndexConstraints},
            5: {type: "boolean", name: "enabled", value: true}, // off, the zone keeps its sample but is not on the map
            10: {type: "int32", name: "key-low", value: 0, ...MidiNoteConstraints},
            11: {type: "int32", name: "key-high", value: 127, ...MidiNoteConstraints},
            12: {type: "int32", name: "key-fade", value: 0, constraints: {min: 0, max: 127}, unit: "st"},
            13: {type: "int32", name: "root-key", value: 60, ...MidiNoteConstraints},
            20: {type: "int32", name: "velocity-low", value: 1, ...Velocity},
            21: {type: "int32", name: "velocity-high", value: 127, ...Velocity},
            22: {type: "int32", name: "velocity-fade", value: 0, constraints: {min: 0, max: 127}, unit: ""},
            30: {type: "int32", name: "transpose", value: 0, constraints: {min: -24, max: 24}, unit: "st"},
            31: {
                type: "float32", name: "tune",
                value: 0.0, constraints: {min: -100.0, max: 100.0, scaling: "linear"}, unit: "ct"
            },
            32: {type: "float32", name: "key-track", value: 1.0, ...UnipolarConstraints},
            40: {type: "float32", name: "gain", value: 0.0, constraints: "decibel", unit: "dB"},
            41: {type: "float32", name: "panning", constraints: "bipolar", unit: ""},
            42: {type: "int32", name: "sequence", value: 1, constraints: {min: 1, max: 128}, unit: ""},
            43: {type: "boolean", name: "reverse", value: false},
            44: {type: "boolean", name: "one-shot", value: false},
            50: {type: "int32", name: "sample-start", value: 0, ...Frames},
            51: {type: "int32", name: "sample-end", value: 0x7FFFFFFF, ...Frames},
            52: {
                type: "int32", name: "loop-mode",
                value: 0, constraints: {values: [0, 1, 2]}, unit: "" // off, on (while held), always
            },
            53: {type: "int32", name: "loop-start", value: 0, ...Frames},
            54: {type: "int32", name: "loop-end", value: 0x7FFFFFFF, ...Frames},
            55: {
                type: "float32", name: "loop-fade",
                value: 0.0, constraints: {min: 0.0, max: 1.0, scaling: "linear"}, unit: "s"
            },
            56: {type: "boolean", name: "loop-alternate", value: false}
        }
    },
    pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}
