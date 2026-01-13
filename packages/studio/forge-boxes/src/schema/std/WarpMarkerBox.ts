import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const WarpMarkerBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WarpMarkerBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.WarpMarkers, mandatory: true},
            2: {type: "int32", name: "position", constraints: "any", unit: "ppqn"},
            3: {type: "float32", name: "seconds", constraints: "non-negative", unit: "seconds"}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}