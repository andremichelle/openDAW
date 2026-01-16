import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const GateDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("GateDeviceBox", {
    10: {
        type: "float32", name: "threshold", pointerRules: ParameterPointerRules,
        value: -40.0, constraints: {min: -80.0, max: 0.0, scaling: "linear"}, unit: "dB"
    },
    11: {
        type: "float32", name: "return", pointerRules: ParameterPointerRules,
        value: 6.0, constraints: {min: 0.0, max: 24.0, scaling: "linear"}, unit: "dB"
    },
    12: {
        type: "float32", name: "attack", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: {min: 0.0, max: 50.0, scaling: "linear"}, unit: "ms"
    },
    13: {
        type: "float32", name: "hold", pointerRules: ParameterPointerRules,
        value: 50.0, constraints: {min: 0.0, max: 500.0, scaling: "linear"}, unit: "ms"
    },
    14: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        value: 100.0, constraints: {min: 1.0, max: 2000.0, scaling: "linear"}, unit: "ms"
    },
    15: {
        type: "float32", name: "floor", pointerRules: ParameterPointerRules,
        value: -80.0, constraints: {min: -80.0, max: 0.0, scaling: "linear"}, unit: "dB"
    },
    30: {
        type: "pointer", name: "side-chain", pointerType: Pointers.SideChain, mandatory: false
    }
})
