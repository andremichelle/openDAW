import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, MidiControlPointerRules, UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const StepsModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("StepsModulatorBox", {
    10: {
        type: "int32", name: "count", pointerRules: MidiControlPointerRules, value: 16,
        constraints: {min: 1, max: 64}, unit: ""
    },
    11: {
        type: "int32", name: "rateSync", pointerRules: MidiControlPointerRules, value: 10, // one step per LfoModulatorBoxAdapter.RatePPQNs entry, 1/16
        constraints: {min: 0, max: 12}, unit: ""
    },
    12: {
        type: "float32", name: "rateAbsolute", pointerRules: MidiControlPointerRules, value: 0.0,
        constraints: {min: 0.0, max: 20.0, scaling: "linear"}, unit: "Hz"
    },
    13: {type: "float32", name: "phase", pointerRules: MidiControlPointerRules, value: 0.0, ...UnipolarConstraints},
    14: {type: "float32", name: "amount", pointerRules: MidiControlPointerRules, value: 1.0, ...UnipolarConstraints},
    15: {type: "float32", name: "smooth", pointerRules: MidiControlPointerRules, value: 0.0, ...UnipolarConstraints},
    16: {
        type: "int32", name: "direction", pointerRules: MidiControlPointerRules, value: 0,
        constraints: {values: [0, 1, 2, 3, 4]}, unit: "" // StepsDirection
    },
    20: {
        type: "array", name: "steps", length: 64,
        element: {type: "float32", value: 0.0, ...BipolarConstraints}
    }
})
