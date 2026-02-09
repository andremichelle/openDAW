import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const VelocityDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("VelocityDeviceBox", {
    10: {
        type: "float32", name: "magnet-position", pointerRules: ParameterPointerRules,
        value: 0.5, constraints: "unipolar", unit: "%"
    },
    11: {
        type: "float32", name: "magnet-strength", pointerRules: ParameterPointerRules,
        constraints: "unipolar", unit: "%"
    },
    12: {
        type: "int32", name: "random-seed",
        value: 0x800, constraints: "any", unit: ""
    },
    13: {
        type: "float32", name: "random-amount", pointerRules: ParameterPointerRules,
        constraints: "unipolar", unit: "%"
    },
    14: {
        type: "float32", name: "offset", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "bipolar", unit: "%"
    },
    15: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    }
})