import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, IndexConstraints} from "../../std/Defaults"

// One per-voice modulation of the Sampler: a source, a target and how far it reaches.
export const SamplerModulationBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SamplerModulationBox",
        fields: {
            1: {type: "pointer", name: "device", pointerType: Pointers.SamplerModulation, mandatory: true},
            2: {type: "int32", name: "index", ...IndexConstraints},
            10: {
                type: "int32", name: "source",
                value: 0, constraints: {values: [0, 1, 2, 3, 4, 5, 6]}, unit: "" // SamplerModulationSource
            },
            11: {
                type: "int32", name: "target",
                value: 0, constraints: {values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}, unit: "" // SamplerModulationTarget
            },
            12: {type: "float32", name: "amount", value: 0.0, ...BipolarConstraints}
        }
    },
    pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}
