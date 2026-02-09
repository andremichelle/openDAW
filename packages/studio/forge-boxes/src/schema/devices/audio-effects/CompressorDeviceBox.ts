import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

// Ported from https://github.com/p-hlp/CTAGDRC

export const CompressorDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("CompressorDeviceBox", {
    10: {type: "boolean", name: "lookahead", pointerRules: ParameterPointerRules, value: false},
    11: {type: "boolean", name: "automakeup", pointerRules: ParameterPointerRules, value: true},
    12: {type: "boolean", name: "autoattack", pointerRules: ParameterPointerRules, value: false},
    13: {type: "boolean", name: "autorelease", pointerRules: ParameterPointerRules, value: false},
    14: {
        type: "float32", name: "inputgain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -30.0, max: 30.0, scaling: "linear"}, unit: "dB"
    },
    15: {
        type: "float32", name: "threshold", pointerRules: ParameterPointerRules,
        value: -10.0, constraints: {min: -60.0, max: 0.0, scaling: "linear"}, unit: "dB"
    },
    16: {
        type: "float32", name: "ratio", pointerRules: ParameterPointerRules,
        value: 2.0, constraints: {min: 1.0, max: 24.0, scaling: "exponential"}, unit: ""
    },
    17: {
        type: "float32", name: "knee", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 24.0, scaling: "linear"}, unit: "dB"
    },
    18: {
        type: "float32", name: "attack", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 100.0, scaling: "linear"}, unit: "ms"
    },
    19: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        value: 25.0, constraints: {min: 5.0, max: 1500.0, scaling: "linear"}, unit: "ms"
    },
    20: {
        type: "float32", name: "makeup", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -40.0, max: 40.0, scaling: "linear"}, unit: "dB"
    },
    21: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    30: {
        type: "pointer", name: "side-chain", pointerType: Pointers.SideChain, mandatory: false
    }
})