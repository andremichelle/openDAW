import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ReverbDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("ReverbDeviceBox", {
    10: {
        type: "float32", name: "decay", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: "unipolar", unit: "%"
    },
    11: {
        type: "float32", name: "pre-delay", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.001, max: 0.500, scaling: "exponential"}, unit: "s"
    },
    12: {
        type: "float32", name: "damp", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: "unipolar", unit: "%"
    },
    13: {
        type: "float32", name: "filter", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: "%"
    },
    14: {
        type: "float32", name: "wet", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: "decibel", unit: "dB"
    },
    15: {
        type: "float32", name: "dry", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    }
})