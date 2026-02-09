import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const SelectionBox: BoxSchema<Pointers> = {
    type: "box",
    ephemeral: true,
    class: {
        name: "SelectionBox",
        fields: {
            1: {type: "pointer", name: "selection", pointerType: Pointers.Selection, mandatory: true},
            2: {type: "pointer", name: "selectable", pointerType: Pointers.Selection, mandatory: true}
        }
    }
}