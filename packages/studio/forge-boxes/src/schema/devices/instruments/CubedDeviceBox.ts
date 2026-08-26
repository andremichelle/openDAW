import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

export const CubedDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("CubedDeviceBox", "notes", {
    10: {
        type: "float32",
        name: "tuning",
        pointerRules: ParameterPointerRules,
        value: 0.0,
        constraints: {min: -1200, max: 1200, scaling: "linear"},
        unit: "ct"
    },
    11: {type: "float32", name: "cutoff", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    12: {type: "float32", name: "resonance", pointerRules: ParameterPointerRules, value: 1.0, ...UnipolarConstraints},
    13: {type: "float32", name: "env-mod", pointerRules: ParameterPointerRules, value: 1.0, ...UnipolarConstraints},
    14: {type: "float32", name: "decay", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    15: {type: "float32", name: "accent", pointerRules: ParameterPointerRules, value: 1.0, ...UnipolarConstraints},
    16: {
        type: "float32",
        name: "volume",
        pointerRules: ParameterPointerRules,
        value: -12.0,
        constraints: "decibel",
        unit: "dB"
    },
    17: {
        type: "int32",
        name: "waveform",
        pointerRules: ParameterPointerRules,
        value: 0,
        constraints: {values: [0, 1]},
        unit: ""
    },
    20: {
        type: "int32",
        name: "pattern-index",
        pointerRules: ParameterPointerRules,
        value: 0,
        constraints: {min: 0, max: 15},
        unit: ""
    },
    30: {
        type: "array", name: "patterns", length: 16, element: {
            type: "object",
            class: {
                name: "CubedPattern",
                fields: {
                    1: {type: "int32", name: "length", value: 16, constraints: {min: 1, max: 64}, unit: ""},
                    // each int32 packs midi-note (7 bits), on/off (1), slide (1), accent (1). adapter packs/unpacks.
                    // 60 = note 60 with all flags off, the born-default step.
                    2: {
                        type: "array",
                        name: "steps",
                        length: 64,
                        element: {type: "int32", value: 60, constraints: "any", unit: ""}
                    }
                }
            }
        }
    },
    99: {type: "int32", name: "version", constraints: "any", unit: ""}
})
