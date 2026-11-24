import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const NoteEventGroupBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteEventGroupBox",
        fields: {
            1: {type: "int32", name: "chance", value: 100, constraints: {min: 0, max: 100}, unit: "%"},
            2: {type: "int32", name: "mode", value: 0, constraints: {min: 0, max: 1}, unit: ""} // 0 play all, 1 play one
        }
    }, pointerRules: {accepts: [Pointers.NoteEventGroup], mandatory: true}
}
