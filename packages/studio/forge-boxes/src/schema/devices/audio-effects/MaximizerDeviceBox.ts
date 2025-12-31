import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

// Maximizer - brickwall limiter with automatic makeup gain

export const MaximizerDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("MaximizerDeviceBox", {
    10: {type: "boolean", name: "lookahead", value: true},
    11: {
        type: "float32", name: "threshold", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -30.0, max: 0.0, scaling: "linear"}, unit: "dB"
    }
})
