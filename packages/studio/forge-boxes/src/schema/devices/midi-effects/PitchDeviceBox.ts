import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const PitchDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("PitchDeviceBox", {
    10: {
        type: "int32", name: "semi-tones", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -36, max: 36}, unit: "st"
    },
    11: {
        type: "float32", name: "cents", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -50.0, max: 50.0, scaling: "linear"}, unit: "ct"
    },
    12: {
        type: "int32", name: "octaves", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -7, max: 7}, unit: "oct"
    }
})