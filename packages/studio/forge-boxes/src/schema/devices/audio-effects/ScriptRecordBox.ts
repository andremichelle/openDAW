import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// one record of a script `@collection`, its values are ScriptValueBox children
export const ScriptRecordBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ScriptRecordBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptRecord, mandatory: true},
            2: {type: "string", name: "collection", value: ""},
            3: {type: "int32", name: "collection-index", constraints: "index", unit: ""},
            4: {type: "int32", name: "order", constraints: "index", unit: ""},
            5: {type: "field", name: "values", pointerRules: {accepts: [Pointers.ScriptValue], mandatory: false}}
        }
    }
}
