import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const MetaDataBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "MetaDataBox",
        fields: {
            1: {type: "pointer", name: "target", mandatory: true, pointerType: Pointers.MetaData},
            2: {type: "string", name: "origin"},
            3: {type: "string", name: "value", value: "{}"} // JSON
        }
    }
}