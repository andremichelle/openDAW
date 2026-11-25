import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// one script `@buffer`, its floats live in ScriptBufferChunkBox children so an edit stores only the chunks it touches
export const ScriptBufferBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ScriptBufferBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptBuffer, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            // legacy single-blob storage, read when there are no chunks, moved into chunks by the first edit
            4: {type: "bytes", name: "data"},
            5: {type: "field", name: "chunks", pointerRules: {accepts: [Pointers.ScriptBufferChunk], mandatory: false}}
        }
    }
}
