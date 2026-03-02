import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const WaveshaperDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("WaveshaperDeviceBox", {
    10: {
        type: "string", name: "equation",
        value: "hardclip"
    },
    11: {
        type: "float32", name: "input-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: 0.0, max: 40.0, scaling: "linear"}, unit: "dB"
    },
    12: {
        type: "float32", name: "output-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -24.0, max: 24.0, scaling: "linear"}, unit: "dB"
    },
    13: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    }
})
