import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// a run of a ScriptBufferBox's floats (little-endian float32 bytes) at position `index`
export const ScriptBufferChunkBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ScriptBufferChunkBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptBufferChunk, mandatory: true},
            2: {type: "int32", name: "index", constraints: "index", unit: ""},
            3: {type: "bytes", name: "data"}
        }
    }
}
