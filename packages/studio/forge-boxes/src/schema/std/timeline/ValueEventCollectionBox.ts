import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const ValueEventCollectionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ValueEventCollectionBox",
        fields: {
            1: {type: "field", name: "events", pointerRules: {accepts: [Pointers.ValueEvents], mandatory: false}},
            2: {
                type: "field",
                name: "owners",
                pointerRules: {accepts: [Pointers.ValueEventCollection], mandatory: true}
            }
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false},
    resource: "shared"
}