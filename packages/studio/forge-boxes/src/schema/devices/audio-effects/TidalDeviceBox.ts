import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const TidalDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("TidalDeviceBox", {
    10: {
        type: "float32", name: "slope", pointerRules: ParameterPointerRules,
        value: -0.25, constraints: "bipolar", unit: "%"
    },
    11: {
        type: "float32", name: "symmetry", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: "unipolar", unit: "%"
    },
    20: {
        type: "float32", name: "rate", pointerRules: ParameterPointerRules,
        value: 3, constraints: "unipolar", unit: "%"
    },
    21: {
        type: "float32", name: "depth", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: ""
    },
    22: {
        type: "float32", name: "offset", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -180, max: 180.0, scaling: "linear"}, unit: "°"
    },
    23: {
        type: "float32", name: "channel-offset", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -180.0, max: 180.0, scaling: "linear"}, unit: "°"
    }
})