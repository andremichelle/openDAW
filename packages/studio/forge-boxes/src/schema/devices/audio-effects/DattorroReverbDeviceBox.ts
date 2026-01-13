import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const DattorroReverbDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createAudioEffect("DattorroReverbDeviceBox", {
        10: {
            type: "float32", name: "preDelay", pointerRules: ParameterPointerRules,
            value: 0, constraints: {min: 0.0, max: 1000.0, scaling: "linear"}, unit: "ms"
        },
        11: {
            type: "float32", name: "bandwidth", pointerRules: ParameterPointerRules,
            value: 0.9999, ...UnipolarConstraints
        },
        12: {
            type: "float32", name: "inputDiffusion1", pointerRules: ParameterPointerRules,
            value: 0.75, ...UnipolarConstraints
        },
        13: {
            type: "float32", name: "inputDiffusion2", pointerRules: ParameterPointerRules,
            value: 0.625, ...UnipolarConstraints
        },
        14: {
            type: "float32", name: "decay", pointerRules: ParameterPointerRules,
            value: 0.75, ...UnipolarConstraints
        },
        15: {
            type: "float32", name: "decayDiffusion1", pointerRules: ParameterPointerRules,
            value: 0.7, ...UnipolarConstraints
        },
        16: {
            type: "float32", name: "decayDiffusion2", pointerRules: ParameterPointerRules,
            value: 0.5, ...UnipolarConstraints
        },
        17: {
            type: "float32", name: "damping", pointerRules: ParameterPointerRules,
            value: 0.005, ...UnipolarConstraints
        },
        18: {
            type: "float32", name: "excursionRate", pointerRules: ParameterPointerRules,
            value: 0.5, ...UnipolarConstraints
        },
        19: {
            type: "float32", name: "excursionDepth", pointerRules: ParameterPointerRules,
            value: 0.7, ...UnipolarConstraints
        },
        20: {
            type: "float32", name: "wet", pointerRules: ParameterPointerRules,
            value: -6.0, constraints: "decibel", unit: "dB"
        },
        21: {
            type: "float32", name: "dry", pointerRules: ParameterPointerRules,
            value: 0.0, constraints: "decibel", unit: "dB"
        }
    })