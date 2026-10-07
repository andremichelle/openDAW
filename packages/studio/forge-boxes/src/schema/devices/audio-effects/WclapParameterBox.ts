import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"

// One automatable CLAP parameter of a WebCLAP device, keys 3 (id) and 4 (value) are what the engine binds
export const WclapParameterBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WclapParameterBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Parameter, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "clap-id", constraints: "any", unit: ""},
            4: {type: "float32", name: "value", constraints: "any", unit: "", pointerRules: ParameterPointerRules},
            5: {type: "float32", name: "defaultValue", constraints: "any", unit: ""},
            6: {type: "float32", name: "min", constraints: "any", unit: ""},
            7: {type: "float32", name: "max", constraints: "any", unit: ""},
            8: {type: "int32", name: "flags", constraints: "any", unit: ""},
            9: {type: "string", name: "module", value: ""}
        }
    }
}
