import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const SwarmDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("SwarmDeviceBox", "notes", {
    10: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: "decibel", unit: "dB"
    },
    11: {
        type: "int32", name: "octave", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -3, max: 3}, unit: "oct"
    },
    12: {type: "boolean", name: "reverse", pointerRules: ParameterPointerRules, value: false},
    14: {
        type: "int32", name: "root-key", pointerRules: ParameterPointerRules,
        value: 60, constraints: {min: 0, max: 127}, unit: ""
    },
    15: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false},
    20: {
        type: "float32", name: "attack", pointerRules: ParameterPointerRules,
        value: 0.001, constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
    },
    21: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        value: 0.1, constraints: {min: 0.001, max: 8.0, scaling: "exponential"}, unit: "s"
    },
    22: {
        type: "float32", name: "sample-start", pointerRules: ParameterPointerRules,
        value: 0.0, ...UnipolarConstraints
    },
    23: {
        type: "float32", name: "sample-end", pointerRules: ParameterPointerRules,
        value: 1.0, ...UnipolarConstraints
    },
    24: {type: "boolean", name: "loop", pointerRules: ParameterPointerRules, value: false},
    25: {
        type: "float32", name: "loop-fade", pointerRules: ParameterPointerRules,
        value: 0.05, constraints: {min: 0.001, max: 1.0, scaling: "exponential"}, unit: "s"
    },
    26: {
        type: "float32", name: "loop-start", pointerRules: ParameterPointerRules,
        value: 0.0, ...UnipolarConstraints
    },
    27: {
        type: "float32", name: "loop-end", pointerRules: ParameterPointerRules,
        value: 1.0, ...UnipolarConstraints
    }
})
