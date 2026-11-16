import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {BipolarConstraints, ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

export const GuitarDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("GuitarDeviceBox", "notes", {
    10: {type: "int32", name: "mode", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 1}, unit: ""},
    11: {type: "int32", name: "rate", pointerRules: ParameterPointerRules, value: 1, constraints: {min: 0, max: 2}, unit: ""},
    12: {type: "float32", name: "speed", pointerRules: ParameterPointerRules, value: 0.3, ...UnipolarConstraints},
    13: {type: "float32", name: "speed-variation", pointerRules: ParameterPointerRules, value: 0.2, ...UnipolarConstraints},
    14: {type: "float32", name: "velocity", pointerRules: ParameterPointerRules, value: 0.8, ...UnipolarConstraints},
    15: {type: "float32", name: "velocity-variation", pointerRules: ParameterPointerRules, value: 0.75, ...UnipolarConstraints},
    18: {type: "int32", name: "position", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 5}, unit: ""},
    19: {type: "int32", name: "tuning", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 3}, unit: ""},
    20: {type: "int32", name: "body", pointerRules: ParameterPointerRules, value: 1, constraints: {min: 0, max: 7}, unit: ""},
    21: {type: "float32", name: "damping", pointerRules: ParameterPointerRules, value: 0.33, ...UnipolarConstraints},
    22: {type: "float32", name: "damping-variation", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    23: {type: "float32", name: "pluck", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    24: {type: "float32", name: "pluck-variation", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    25: {type: "float32", name: "tension", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    28: {type: "float32", name: "spread", pointerRules: ParameterPointerRules, value: 0.6, ...UnipolarConstraints},
    29: {type: "float32", name: "volume", pointerRules: ParameterPointerRules, value: -6.0, constraints: "decibel", unit: "dB"},
    36: {type: "float32", name: "spot", pointerRules: ParameterPointerRules, value: 0.2, ...UnipolarConstraints},
    37: {type: "int32", name: "pick", pointerRules: ParameterPointerRules, value: 3, constraints: {min: 0, max: 3}, unit: ""},
    38: {type: "pointer", name: "groove", pointerType: Pointers.Groove, mandatory: false},
    39: {type: "float32", name: "tilt", pointerRules: ParameterPointerRules, value: 0.0, ...BipolarConstraints},
    41: {type: "int32", name: "slot", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 15}, unit: ""},
    43: {type: "int32", name: "chord", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 16}, unit: ""},
    // 5 bits per string from the low E, 31 mutes a string, all muted is an empty shape
    44: {type: "array", name: "shapes", length: 16, element: {type: "int32", value: 1073741823, constraints: "any", unit: ""}},
    42: {
        type: "array", name: "patterns", length: 16, element: {
            type: "object", class: {
                name: "GuitarPattern", fields: {
                    1: {type: "array", name: "step-kinds", length: 64, element: {type: "int32", value: 0, constraints: {min: 0, max: 9}, unit: ""}},
                    2: {type: "array", name: "step-strings", length: 64, element: {type: "int32", value: 63, constraints: {min: 0, max: 63}, unit: ""}},
                    3: {type: "array", name: "step-velocities", length: 64, element: {type: "int32", value: 80, constraints: {min: 0, max: 100}, unit: "%"}},
                    4: {type: "array", name: "step-speeds", length: 64, element: {type: "int32", value: 50, constraints: {min: 0, max: 100}, unit: "%"}},
                    5: {type: "int32", name: "length", value: 16, constraints: {min: 1, max: 64}, unit: ""},
                    6: {type: "int32", name: "library", value: -1, constraints: {min: -1, max: 255}, unit: ""},
                    7: {type: "array", name: "step-bends", length: 64, element: {type: "int32", value: 0, constraints: {min: 0, max: 262143}, unit: ""}}
                }
            }
        }
    }
})
