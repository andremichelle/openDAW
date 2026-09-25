import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const CrusherDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("CrusherDeviceBox", {
    10: {
        type: "float32", name: "crush", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "unipolar", unit: "%"
    },
    11: {
        type: "int32", name: "bits", pointerRules: ParameterPointerRules,
        value: 16, constraints: {min: 1, max: 16}, unit: "bits"
    },
    12: {
        type: "float32", name: "boost", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 24.0, scaling: "linear"}, unit: "dB"
    },
    13: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    }
})