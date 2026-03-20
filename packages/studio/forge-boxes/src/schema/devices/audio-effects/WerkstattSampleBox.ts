import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const WerkstattSampleBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WerkstattSampleBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Sample, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false}
        }
    }
}
