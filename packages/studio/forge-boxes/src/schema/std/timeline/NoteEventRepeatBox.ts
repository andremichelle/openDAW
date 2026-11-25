import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, UnipolarConstraints} from "../Defaults"

export const NoteEventRepeatBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteEventRepeatBox",
        fields: {
            1: {type: "pointer", name: "event", pointerType: Pointers.NoteEventRepeat, mandatory: true},
            2: {type: "int32", name: "count", value: 1, constraints: {min: 1, max: 128}, unit: ""},
            3: {type: "float32", name: "curve", value: 0.0, ...BipolarConstraints},
            4: {type: "float32", name: "length", value: 1.0, ...UnipolarConstraints},
            5: {type: "float32", name: "velocity-fade", value: 0.0, ...BipolarConstraints}
        }
    }
}