import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// one script `@buffer`: `length` float32 values, little-endian bytes
export const ScriptBufferBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ScriptBufferBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptBuffer, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "bytes", name: "data"}
        }
    }
}
