import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const AutotuneDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("AutotuneDeviceBox", {
    10: {
        type: "int32", name: "key", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 11}, unit: ""
    },
    11: {
        type: "int32", name: "scale", pointerRules: ParameterPointerRules,
        value: 1, constraints: {min: 0, max: 7}, unit: ""
    },
    12: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    13: {
        type: "float32", name: "retune", pointerRules: ParameterPointerRules,
        value: 0.50, constraints: "unipolar", unit: "%"
    },
    14: {
        type: "float32", name: "shift", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -12.0, max: 12.0, scaling: "linear"}, unit: "st"
    },
    15: {
        type: "float32", name: "smooth", pointerRules: ParameterPointerRules,
        value: 0.60, constraints: "unipolar", unit: "%"
    }
})
