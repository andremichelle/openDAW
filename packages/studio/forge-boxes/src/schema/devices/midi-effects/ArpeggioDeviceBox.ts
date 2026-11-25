import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ArpeggioDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("ArpeggioDeviceBox", {
    10: {
        type: "int32", name: "mode-index", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 18}, unit: ""
    },
    11: {
        type: "int32", name: "num-octaves", pointerRules: ParameterPointerRules,
        value: 1, constraints: {min: 1, max: 5}, unit: "oct"
    },
    12: {
        type: "int32", name: "rate-index", pointerRules: ParameterPointerRules,
        value: 9, constraints: {length: 17}, unit: ""
    },
    13: {
        type: "float32", name: "gate", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.0, max: 2.0, scaling: "linear"}, unit: ""
    },
    14: {
        type: "int32", name: "repeat", pointerRules: ParameterPointerRules,
        value: 1, constraints: {min: 1, max: 16}, unit: ""
    },
    15: {
        type: "float32", name: "velocity", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: ""
    },
    16: {
        type: "int32", name: "order", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 2}, unit: ""
    },
    17: {type: "boolean", name: "hold", pointerRules: ParameterPointerRules, value: false},
    18: {
        type: "int32", name: "retrigger", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 4}, unit: ""
    },
    19: {
        type: "int32", name: "offset", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 15}, unit: ""
    },
    20: {type: "int32", name: "seed", value: 0, constraints: {min: 0, max: 999999}, unit: ""},
    21: {type: "boolean", name: "follow-chords", pointerRules: ParameterPointerRules, value: false},
    30: {type: "array", name: "step-kinds", length: 64, element: {type: "int32", value: 0, constraints: {length: 4}, unit: ""}},
    31: {type: "array", name: "step-velocities", length: 64, element: {type: "int32", value: 100, constraints: {min: 0, max: 100}, unit: "%"}},
    32: {type: "array", name: "step-gates", length: 64, element: {type: "int32", value: 100, constraints: {min: 0, max: 200}, unit: "%"}},
    33: {type: "array", name: "step-transposes", length: 64, element: {type: "int32", value: 0, constraints: {min: -12, max: 12}, unit: "st"}},
    34: {type: "array", name: "step-octaves", length: 64, element: {type: "int32", value: 0, constraints: {min: -2, max: 2}, unit: "oct"}},
    35: {type: "array", name: "step-chances", length: 64, element: {type: "int32", value: 100, constraints: {min: 0, max: 100}, unit: "%"}},
    36: {type: "array", name: "step-ratchets", length: 64, element: {type: "int32", value: 1, constraints: {min: 1, max: 7}, unit: ""}},
    37: {type: "int32", name: "pattern-length", value: 16, constraints: {min: 1, max: 64}, unit: ""},
    99: {type: "int32", name: "version", constraints: "any", unit: ""}
})