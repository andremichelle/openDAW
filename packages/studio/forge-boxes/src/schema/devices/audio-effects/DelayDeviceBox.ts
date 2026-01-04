import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const DelayDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("DelayDeviceBox", {
    9: {type: "int32", name: "version", constraints: "any", unit: ""},
    10: {
        type: "float32", name: "delay", pointerRules: ParameterPointerRules,
        value: 13, constraints: "any", unit: ""  // 3/16 in ascending array (21 values: 0=off, 1=1/128, ..., 20=1/1)
    },
    11: {
        type: "float32", name: "feedback", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: "unipolar", unit: "%"
    },
    12: {
        type: "float32", name: "cross", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "unipolar", unit: "%"
    },
    13: {
        type: "float32", name: "filter", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: "%"
    },
    14: {
        type: "float32", name: "wet", pointerRules: ParameterPointerRules,
        value: -6.0, constraints: "decibel", unit: "dB"
    },
    15: {
        type: "float32", name: "dry", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    // Pre-delay Left
    16: {
        type: "float32", name: "pre-sync-time-left", pointerRules: ParameterPointerRules,
        value: 0, constraints: "any", unit: ""
    },
    17: {
        type: "float32", name: "pre-millis-time-left", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 500.0, scaling: "linear"}, unit: "ms"
    },
    // Pre-delay Right
    19: {
        type: "float32", name: "pre-sync-time-right", pointerRules: ParameterPointerRules,
        value: 0, constraints: "any", unit: ""
    },
    20: {
        type: "float32", name: "pre-millis-time-right", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 500.0, scaling: "linear"}, unit: "ms"
    },
    // Additional delay time
    22: {
        type: "float32", name: "millis-time", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 500.0, scaling: "linear"}, unit: "ms"
    },
    // LFO modulation
    23: {
        type: "float32", name: "lfo-speed", pointerRules: ParameterPointerRules,
        value: 0.1, constraints: {min: 0.1, max: 25.0, scaling: "exponential"}, unit: "Hz"
    },
    24: {
        type: "float32", name: "lfo-depth", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 50.0, scaling: "linear"}, unit: "ms"
    }
})