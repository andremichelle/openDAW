import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const NeuralAmpDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("NeuralAmpDeviceBox", {
    10: {type: "string", name: "model-json"},
    11: {
        type: "float32", name: "input-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    12: {
        type: "float32", name: "output-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    13: {type: "boolean", name: "mono", value: true},
    14: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.0, max: 1.0, scaling: "linear"}, unit: "%"
    }
})
