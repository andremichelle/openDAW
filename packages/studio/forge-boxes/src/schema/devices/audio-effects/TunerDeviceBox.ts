import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const TunerDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("TunerDeviceBox", {
    10: {type: "float32", name: "reference", value: 440, constraints: {min: 410, max: 480, scaling: "linear"}, unit: "Hz", pointerRules: ParameterPointerRules},
    20: {type: "int32", name: "view", value: 0, constraints: {min: 0, max: 1}, unit: ""},
    21: {type: "boolean", name: "showFrequency", value: false},
    23: {type: "boolean", name: "autoFollow", value: true},
    24: {type: "float32", name: "historyCenter", value: 69, constraints: {min: 12, max: 120, scaling: "linear"}, unit: "st"},
    25: {type: "float32", name: "historySpan", value: 6, constraints: {min: 2, max: 24, scaling: "linear"}, unit: "st"},
    26: {type: "boolean", name: "strobe", value: false}
})
