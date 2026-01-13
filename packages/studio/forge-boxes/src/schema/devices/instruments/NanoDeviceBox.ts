import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const NanoDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("NanoDeviceBox", {
    10: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: "decibel", unit: "dB"
    },
    15: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false},
    20: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        value: 0.1, constraints: {min: 0.001, max: 8.0, scaling: "exponential"}, unit: "s"
    }
})