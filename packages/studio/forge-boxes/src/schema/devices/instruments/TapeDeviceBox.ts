import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const TapeDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("TapeDeviceBox", {
    10: {type: "float32", name: "flutter", pointerRules: ParameterPointerRules, ...UnipolarConstraints},
    11: {type: "float32", name: "wow", pointerRules: ParameterPointerRules, ...UnipolarConstraints},
    12: {type: "float32", name: "noise", pointerRules: ParameterPointerRules, ...UnipolarConstraints},
    13: {type: "float32", name: "saturation", pointerRules: ParameterPointerRules, ...UnipolarConstraints}
}, Pointers.Automation)