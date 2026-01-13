import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const FoldDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("FoldDeviceBox", {
    10: {
        type: "float32", name: "drive", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 30.0, scaling: "linear"}, unit: "dB"
    },
    11: {
        type: "int32", name: "over-sampling",
        value: 0, constraints: {length: 3}, unit: ""
    },
    12: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -18.0, max: 0.0, scaling: "linear"}, unit: "dB"
    }
})