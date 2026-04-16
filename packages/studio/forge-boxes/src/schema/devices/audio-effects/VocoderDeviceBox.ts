import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const VocoderDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("VocoderDeviceBox", {
    10: {
        type: "float32", name: "carrier-min-freq", pointerRules: ParameterPointerRules,
        value: 80.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"
    },
    11: {
        type: "float32", name: "carrier-max-freq", pointerRules: ParameterPointerRules,
        value: 12000.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"
    },
    12: {
        type: "float32", name: "modulator-min-freq", pointerRules: ParameterPointerRules,
        value: 80.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"
    },
    13: {
        type: "float32", name: "modulator-max-freq", pointerRules: ParameterPointerRules,
        value: 12000.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"
    },
    14: {
        type: "float32", name: "q-min", pointerRules: ParameterPointerRules,
        value: 2.0, constraints: {min: 1.0, max: 60.0, scaling: "exponential"}, unit: ""
    },
    15: {
        type: "float32", name: "q-max", pointerRules: ParameterPointerRules,
        value: 20.0, constraints: {min: 1.0, max: 60.0, scaling: "exponential"}, unit: ""
    },
    16: {
        type: "float32", name: "env-release", pointerRules: ParameterPointerRules,
        value: 30.0, constraints: {min: 1.0, max: 1000.0, scaling: "exponential"}, unit: "ms"
    },
    17: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    20: {
        type: "float32", name: "env-attack", pointerRules: ParameterPointerRules,
        value: 5.0, constraints: {min: 0.1, max: 100.0, scaling: "exponential"}, unit: "ms"
    },
    21: {
        type: "float32", name: "gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -20.0, max: 20.0, scaling: "linear"}, unit: "dB"
    },
    18: {type: "int32", name: "band-count", value: 16, constraints: {min: 8, max: 16}, unit: ""},
    19: {type: "string", name: "modulator-source", value: "noise-pink"},
    30: {type: "pointer", name: "side-chain", pointerType: Pointers.SideChain, mandatory: false}
})
