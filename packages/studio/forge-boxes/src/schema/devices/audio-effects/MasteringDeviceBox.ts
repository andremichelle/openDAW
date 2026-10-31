import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

// Mastering - applies a stored reference match (Matchering) on the output: mid/side EQ, gain, limiter

export const MasteringDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("MasteringDeviceBox", {
    10: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    11: {
        type: "float32", name: "gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -12.0, max: 12.0, scaling: "linear"}, unit: "dB"
    },
    12: {
        type: "float32", name: "width", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.0, max: 2.0, scaling: "linear"}, unit: "%"
    },
    13: {
        type: "float32", name: "ceiling", pointerRules: ParameterPointerRules,
        value: -0.0162, constraints: {min: -6.0, max: 0.0, scaling: "linear"}, unit: "dB"
    },
    14: {type: "boolean", name: "limiter", value: true},
    20: {type: "float32", name: "match-gain", value: 1.0, constraints: "any", unit: ""},
    21: {type: "float32", name: "final-amplitude", value: 1.0, constraints: "any", unit: ""},
    22: {type: "bytes", name: "mid-curve"},
    23: {type: "bytes", name: "side-curve"},
    24: {type: "string", name: "reference-name"},
    25: {type: "bytes", name: "reference-profile"},
    26: {type: "string", name: "section"}
})
