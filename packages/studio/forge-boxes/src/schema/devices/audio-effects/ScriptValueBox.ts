import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// one `@field` value of a ScriptRecordBox
export const ScriptValueBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ScriptValueBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptValue, mandatory: true},
            2: {type: "string", name: "field", value: ""},
            3: {type: "int32", name: "field-index", constraints: "index", unit: ""},
            4: {type: "float32", name: "value", constraints: "any", unit: ""}
        }
    }
}
