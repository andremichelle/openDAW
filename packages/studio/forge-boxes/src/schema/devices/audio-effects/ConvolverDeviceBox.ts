import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ConvolverDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("ConvolverDeviceBox", {
    10: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false},
    11: {
        type: "float32", name: "wet", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: "decibel", unit: "dB"
    },
    12: {
        type: "float32", name: "dry", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    13: {
        type: "float32", name: "pre-delay", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.001, max: 0.500, scaling: "exponential"}, unit: "s"
    },
    14: {type: "boolean", name: "normalize", pointerRules: ParameterPointerRules, value: true},
    15: {type: "boolean", name: "reverse", pointerRules: ParameterPointerRules}
})
