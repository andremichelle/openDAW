import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const WerkstattSidechainBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WerkstattSidechainBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.ScriptSideChain, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "pointer", name: "source", pointerType: Pointers.SideChain, mandatory: false}
        }
    }
}
