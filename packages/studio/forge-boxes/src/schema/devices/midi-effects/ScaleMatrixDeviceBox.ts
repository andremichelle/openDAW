import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ScaleMatrixDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("ScaleMatrixDeviceBox", {
    10: {
        type: "int32", name: "root", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 11}, unit: ""
    },
    11: {
        type: "int32", name: "scale", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 16}, unit: ""
    },
    12: {type: "boolean", name: "follow", pointerRules: ParameterPointerRules, value: false},
    13: {type: "array", name: "custom", length: 12, element: {type: "int32", value: 0, constraints: {min: -6, max: 12}, unit: "st"}}
})
