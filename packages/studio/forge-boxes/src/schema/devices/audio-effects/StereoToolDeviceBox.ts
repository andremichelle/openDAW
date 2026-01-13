import {Mixing} from "@moises-ai/lib-dsp"
import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const StereoToolDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("StereoToolDeviceBox", {
    10: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -72.0, mid: 0.0, max: 12.0, scaling: "decibel"}, unit: "dB"
    },
    11: {
        type: "float32", name: "panning", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: "%"
    },
    12: {
        type: "float32", name: "stereo", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: "%"
    },
    13: {type: "boolean", name: "invert-l", pointerRules: ParameterPointerRules},
    14: {type: "boolean", name: "invert-r", pointerRules: ParameterPointerRules},
    15: {type: "boolean", name: "swap", pointerRules: ParameterPointerRules},
    20: {
        type: "int32", name: "panning-mixing",
        value: Mixing.EqualPower,
        constraints: {
            values: [Mixing.Linear, Mixing.EqualPower]
        }, unit: ""
    }
})