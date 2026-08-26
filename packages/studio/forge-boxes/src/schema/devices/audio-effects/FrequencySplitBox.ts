import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const FrequencySplitBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("FrequencySplitBox", {
    10: {type: "field", name: "entries", pointerRules: {accepts: [Pointers.AudioEffectCompositeCell], mandatory: false}},
    11: {type: "field", name: "input", pointerRules: {accepts: [Pointers.SideChain], mandatory: false}},
    12: {
        type: "float32", name: "dry", pointerRules: ParameterPointerRules,
        value: Number.NEGATIVE_INFINITY, constraints: "decibel", unit: "dB"
    },
    13: {
        type: "float32", name: "wet", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    14: {
        type: "float32", name: "crossover1", pointerRules: ParameterPointerRules,
        value: 200.0, constraints: {min: 20.0, max: 20_000.0, scaling: "exponential"}, unit: "Hz"
    },
    15: {
        type: "float32", name: "crossover2", pointerRules: ParameterPointerRules,
        value: 1000.0, constraints: {min: 20.0, max: 20_000.0, scaling: "exponential"}, unit: "Hz"
    },
    16: {
        type: "float32", name: "crossover3", pointerRules: ParameterPointerRules,
        value: 5000.0, constraints: {min: 20.0, max: 20_000.0, scaling: "exponential"}, unit: "Hz"
    }
})
