import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

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