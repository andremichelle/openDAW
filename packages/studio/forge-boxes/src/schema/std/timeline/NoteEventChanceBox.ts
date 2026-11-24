import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const NoteEventChanceBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteEventChanceBox",
        fields: {
            1: {type: "pointer", name: "event", pointerType: Pointers.NoteEventChance, mandatory: true},
            2: {type: "int32", name: "chance", value: 100, constraints: {min: 0, max: 100}, unit: "%"}
        }
    }
}
