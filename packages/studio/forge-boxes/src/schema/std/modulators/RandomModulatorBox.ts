import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ModulatorParameterPointerRules, UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const RandomModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("RandomModulatorBox", {
    10: {
        type: "int32", name: "loop", pointerRules: ModulatorParameterPointerRules, value: 0, // 0 never repeats
        constraints: {min: 0, max: 64}, unit: ""
    },
    11: {
        type: "int32", name: "rateSync", pointerRules: ModulatorParameterPointerRules, value: 10, // LfoModulatorBoxAdapter.RatePPQNs, 1/16
        constraints: {min: 0, max: 12}, unit: ""
    },
    12: {
        type: "float32", name: "rateAbsolute", pointerRules: ModulatorParameterPointerRules, value: 0.0,
        constraints: {min: 0.0, max: 20.0, scaling: "linear"}, unit: "Hz"
    },
    13: {type: "float32", name: "phase", pointerRules: ModulatorParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    15: {type: "float32", name: "smooth", pointerRules: ModulatorParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    16: {
        type: "int32", name: "seed", pointerRules: ModulatorParameterPointerRules, value: 1,
        constraints: {min: 0, max: 999999}, unit: ""
    },
    17: {
        type: "int32", name: "levels", pointerRules: ModulatorParameterPointerRules, value: 0, // 0 stays continuous
        constraints: {min: 0, max: 32}, unit: ""
    }
})
