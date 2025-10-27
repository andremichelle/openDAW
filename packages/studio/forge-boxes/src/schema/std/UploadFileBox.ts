import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const UploadFileBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "UploadFileBox",
        fields: {
            1: {type: "pointer", name: "user", pointerType: Pointers.FileUploadState, mandatory: true},
            2: {
                type: "pointer",
                name: "file",
                pointerType: Pointers.FileUploadState,
                mandatory: true
            }
        }
    },
    ephemeral: true
}