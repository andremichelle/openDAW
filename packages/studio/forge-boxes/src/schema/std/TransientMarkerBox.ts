import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const TransientMarkerBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "TransientMarkerBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.TransientMarkers, mandatory: true},
            2: {type: "float32", name: "position", constraints: "non-negative", unit: "seconds"}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}