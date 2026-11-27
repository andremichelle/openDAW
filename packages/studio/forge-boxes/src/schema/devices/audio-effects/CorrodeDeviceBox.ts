import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const CorrodeDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("CorrodeDeviceBox", {
    10: {
        type: "int32", name: "mode", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 2}, unit: "" // 0 noise, 1 wide noise, 2 sine
    },
    11: {
        type: "float32", name: "frequency", pointerRules: ParameterPointerRules,
        value: 3000.0, constraints: {min: 50.0, max: 18000.0, scaling: "exponential"}, unit: "Hz"
    },
    12: {
        type: "float32", name: "width", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.08, max: 10.0, scaling: "exponential"}, unit: "oct"
    },
    13: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 20.0, constraints: {min: 0.0, max: 100.0, scaling: "linear"}, unit: ""
    }
})
