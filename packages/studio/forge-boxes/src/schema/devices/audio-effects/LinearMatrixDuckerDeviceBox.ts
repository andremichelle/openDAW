import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const LinearMatrixDuckerDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("LinearMatrixDuckerDeviceBox", {
    10: {
        type: "float32", name: "threshold", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -48.0, max: 0.0, scaling: "linear"}, unit: "dB"
    },
    11: {
        type: "float32", name: "attack", pointerRules: ParameterPointerRules,
        value: 5.0, constraints: {min: 0.0, max: 10.0, scaling: "linear"}, unit: "ms"
    },
    12: {
        type: "float32", name: "hold", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 500.0, scaling: "linear"}, unit: "ms"
    },
    13: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        value: 5.0, constraints: {min: 1.0, max: 2000.0, scaling: "exponential"}, unit: "ms"
    },
    // 0 peak, 1 inter-sample peak, 2 rms
    14: {
        type: "int32", name: "mode", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: 0, max: 2}, unit: ""
    },
    15: {
        type: "float32", name: "range", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.0, max: 2.0, scaling: "linear"}, unit: "%"
    },
    16: {
        type: "float32", name: "stereo", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "unipolar", unit: "%"
    },
    17: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    30: {
        type: "pointer", name: "side-chain", pointerType: Pointers.SideChain, mandatory: false
    }
})
