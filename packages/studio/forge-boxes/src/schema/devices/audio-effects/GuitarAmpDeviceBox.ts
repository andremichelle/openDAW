import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const GuitarAmpDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("GuitarAmpDeviceBox", {
    10: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: "unipolar", unit: "%"
    },
    11: {
        type: "float32", name: "output", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -24.0, max: 24.0, scaling: "linear"}, unit: "dB"
    },
    12: {
        type: "boolean", name: "lowLatency",
        value: true
    }
})
