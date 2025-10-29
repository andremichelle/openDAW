import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const ValueEventCurveBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ValueEventCurveBox",
        fields: {
            1: {type: "pointer", name: "event", pointerType: Pointers.ValueInterpolation, mandatory: true},
            2: {type: "float32", name: "slope", value: 0.5}
        }
    }
}