import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ArpeggioDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("ArpeggioDeviceBox", {
    10: {
        type: "int32", name: "mode-index", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 3}, unit: ""
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
    }
})