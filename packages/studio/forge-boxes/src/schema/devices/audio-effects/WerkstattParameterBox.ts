import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"

export const WerkstattParameterBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WerkstattParameterBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Parameter, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "float32", name: "value", constraints: "unipolar", unit: "%", pointerRules: ParameterPointerRules},
            5: {type: "float32", name: "defaultValue", constraints: "unipolar", unit: "%"}
        }
    }
}
