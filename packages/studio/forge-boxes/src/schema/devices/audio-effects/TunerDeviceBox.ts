import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const TunerDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("TunerDeviceBox", {
    10: {type: "float32", name: "reference", value: 440, constraints: {min: 410, max: 480, scaling: "linear"}, unit: "Hz", pointerRules: ParameterPointerRules},
    11: {type: "float32", name: "threshold", value: -55, constraints: {min: -80, max: -20, scaling: "linear"}, unit: "dB", pointerRules: ParameterPointerRules},
    12: {type: "int32", name: "channel", value: 0, constraints: {min: 0, max: 2}, unit: "", pointerRules: ParameterPointerRules},
    13: {type: "float32", name: "smooth", value: 0.15, constraints: "unipolar", unit: "%", pointerRules: ParameterPointerRules},
    20: {type: "int32", name: "view", value: 0, constraints: {min: 0, max: 2}, unit: ""},
    21: {type: "boolean", name: "showFrequency", value: false},
    22: {type: "int32", name: "spelling", value: 0, constraints: {min: 0, max: 2}, unit: ""},
    23: {type: "boolean", name: "autoFollow", value: true},
    24: {type: "float32", name: "historyCenter", value: 69, constraints: {min: 12, max: 120, scaling: "linear"}, unit: "st"},
    25: {type: "float32", name: "historySpan", value: 6, constraints: {min: 2, max: 24, scaling: "linear"}, unit: "st"}
})
