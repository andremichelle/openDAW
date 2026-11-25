import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const NoteFilterDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("NoteFilterDeviceBox", {
    10: {
        type: "int32", name: "min", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 127}, unit: ""
    },
    11: {
        type: "int32", name: "max", pointerRules: ParameterPointerRules,
        value: 127, constraints: {min: 0, max: 127}, unit: ""
    },
    12: {type: "boolean", name: "set", pointerRules: ParameterPointerRules, value: false},
    13: {
        type: "int32", name: "transpose", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -127, max: 127}, unit: "st"
    },
    14: {
        type: "int32", name: "key", pointerRules: ParameterPointerRules,
        value: 60, constraints: {min: 0, max: 127}, unit: ""
    }
})
