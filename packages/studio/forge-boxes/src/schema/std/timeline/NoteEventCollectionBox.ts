import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const NoteEventCollectionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteEventCollectionBox",
        fields: {
            1: {type: "field", name: "events", pointerRules: {accepts: [Pointers.NoteEvents], mandatory: false}},
            2: {type: "field", name: "owners", pointerRules: {accepts: [Pointers.NoteEventCollection], mandatory: true}}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false},
    resource: "shared"
}