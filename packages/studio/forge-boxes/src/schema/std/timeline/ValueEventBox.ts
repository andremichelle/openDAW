import {BoxSchema, deprecated} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {IndexConstraints, PPQNPositionConstraints} from "../Defaults"

export const ValueEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ValueEventBox",
        fields: {
            1: {type: "pointer", name: "events", pointerType: Pointers.ValueEvents, mandatory: true},
            10: {type: "int32", name: "position", ...PPQNPositionConstraints},
            11: {type: "int32", name: "index", ...IndexConstraints},
            12: {
                type: "int32", name: "interpolation",
                value: 1 /* default is linear */, constraints: {values: [0, 1]}, unit: "",
                pointerRules: {accepts: [Pointers.ValueInterpolation], mandatory: false}
            },
            13: {type: "float32", name: "value", constraints: "any", unit: ""},
            14: {type: "float32", name: "slope", deprecated, constraints: "any", unit: "", value: NaN}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}