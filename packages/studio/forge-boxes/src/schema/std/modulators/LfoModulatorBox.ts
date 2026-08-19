import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const LfoModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("LfoModulatorBox", {
    10: {
        type: "int32", name: "shape", value: 0,
        constraints: {values: [0, 1, 2, 3, 4]}, unit: "" // LfoShape
    },
    11: {
        type: "int32", name: "rateSync", value: 4, // LfoModulatorBoxAdapter.RatePPQNs, one bar
        constraints: {min: 0, max: 12}, unit: ""
    },
    12: {
        type: "float32", name: "rateAbsolute", value: 0.0,
        constraints: {min: 0.0, max: 20.0, scaling: "linear"}, unit: "Hz"
    },
    13: {type: "float32", name: "phase", value: 0.0, ...UnipolarConstraints},
    14: {type: "float32", name: "amount", value: 1.0, ...UnipolarConstraints},
    15: {
        type: "float32", name: "exponent", value: 1.0,
        constraints: {min: 0.125, max: 8.0, scaling: "linear"}, unit: ""
    }
})
