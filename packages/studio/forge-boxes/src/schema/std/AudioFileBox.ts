import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const AudioFileBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioFileBox",
        fields: {
            1: {type: "float32", name: "start-in-seconds", constraints: "non-negative", unit: "s"},
            2: {type: "float32", name: "end-in-seconds", constraints: "non-negative", unit: "s"},
            3: {type: "string", name: "file-name"},
            10: {
                type: "field", name: "transient-markers",
                pointerRules: {accepts: [Pointers.TransientMarkers], mandatory: false}
            }
        }
    }, pointerRules: {accepts: [Pointers.AudioFile, Pointers.FileUploadState, Pointers.MetaData], mandatory: true}
}