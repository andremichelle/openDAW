import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const RandomModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("RandomModulatorBox", {
    10: {
        type: "int32", name: "loop", value: 0, // 0 never repeats
        constraints: {min: 0, max: 64}, unit: ""
    },
    11: {
        type: "int32", name: "rateSync", value: 10, // LfoModulatorBoxAdapter.RatePPQNs, 1/16
        constraints: {min: 0, max: 12}, unit: ""
    },
    12: {
        type: "float32", name: "rateAbsolute", value: 0.0,
        constraints: {min: 0.0, max: 20.0, scaling: "linear"}, unit: "Hz"
    },
    13: {type: "float32", name: "phase", value: 0.0, ...UnipolarConstraints},
    14: {type: "float32", name: "amount", value: 1.0, ...UnipolarConstraints},
    15: {type: "float32", name: "smooth", value: 0.0, ...UnipolarConstraints},
    16: {
        type: "int32", name: "seed", value: 1,
        constraints: {min: 0, max: 999999}, unit: ""
    },
    17: {
        type: "int32", name: "levels", value: 0, // 0 stays continuous
        constraints: {min: 0, max: 32}, unit: ""
    }
})
