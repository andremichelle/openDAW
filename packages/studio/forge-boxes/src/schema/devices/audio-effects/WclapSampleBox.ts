import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// A WebCLAP plugin's sample slot (opendaw.samples/1): the plugin's key and the sample it holds. The keys of
// WerkstattSampleBox's index (3) and file (4), so the engine delivers it the same way.
export const WclapSampleBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WclapSampleBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Sample, mandatory: true},
            3: {type: "int32", name: "index", constraints: "any", unit: ""},
            4: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false}
        }
    }
}
