import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

export const KorpusDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("KorpusDeviceBox", "notes", {
    10: {
        type: "int32", name: "exciter", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 4}, unit: ""
    },
    11: {type: "float32", name: "intensity", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    12: {type: "float32", name: "position", pointerRules: ParameterPointerRules, value: 0.35, ...UnipolarConstraints},
    13: {type: "float32", name: "vibrato", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    14: {
        type: "int32", name: "object-a", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 5}, unit: ""
    },
    15: {type: "float32", name: "damping-a", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    16: {
        type: "int32", name: "tune-a", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -24, max: 24}, unit: "st"
    },
    17: {type: "float32", name: "width-a", pointerRules: ParameterPointerRules, value: 0.6, ...UnipolarConstraints},
    18: {
        type: "int32", name: "object-b", pointerRules: ParameterPointerRules,
        value: 6, constraints: {min: 0, max: 6}, unit: ""
    },
    19: {type: "float32", name: "damping-b", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    20: {
        type: "int32", name: "tune-b", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -24, max: 24}, unit: "st"
    },
    21: {
        type: "float32", name: "detune-b", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -25.0, max: 25.0, scaling: "linear"}, unit: "ct"
    },
    22: {type: "float32", name: "width-b", pointerRules: ParameterPointerRules, value: 0.8, ...UnipolarConstraints},
    23: {type: "float32", name: "level-b", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    24: {
        type: "int32", name: "routing", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 1}, unit: ""
    },
    25: {type: "float32", name: "couple", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    26: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: -9.0, constraints: "decibel", unit: "dB"
    },
    27: {type: "int32", name: "preset-epoch", value: 0, constraints: "any", unit: ""}
})
