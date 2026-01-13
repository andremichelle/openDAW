import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {UnipolarConstraints} from "../Defaults"

export const ValueEventCurveBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ValueEventCurveBox",
        fields: {
            1: {type: "pointer", name: "event", pointerType: Pointers.ValueInterpolation, mandatory: true},
            2: {type: "float32", name: "slope", value: 0.5, ...UnipolarConstraints}
        }
    }
}