import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const StepsModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("StepsModulatorBox", {
    10: {
        type: "int32", name: "count", value: 16,
        constraints: {min: 1, max: 64}, unit: ""
    },
    11: {
        type: "int32", name: "rateSync", value: 9, // one step per LfoModulatorBoxAdapter.Rates entry, 1/16
        constraints: {min: 0, max: 11}, unit: ""
    },
    12: {
        type: "float32", name: "rateAbsolute", value: 0.0,
        constraints: {min: 0.0, max: 20.0, scaling: "linear"}, unit: "Hz"
    },
    13: {type: "float32", name: "phase", value: 0.0, ...UnipolarConstraints},
    14: {type: "float32", name: "amount", value: 1.0, ...UnipolarConstraints},
    15: {type: "float32", name: "smooth", value: 0.0, ...UnipolarConstraints},
    16: {
        type: "int32", name: "direction", value: 0,
        constraints: {values: [0, 1, 2, 3, 4]}, unit: "" // StepsDirection
    },
    20: {
        type: "array", name: "steps", length: 64,
        element: {type: "float32", value: 0.0, ...BipolarConstraints}
    }
})
