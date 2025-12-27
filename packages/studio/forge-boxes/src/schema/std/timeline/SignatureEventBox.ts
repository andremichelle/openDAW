import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {PPQNPositionConstraints} from "../Defaults"

export const SignatureEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SignatureEventBox",
        fields: {
            1: {type: "pointer", name: "events", pointerType: Pointers.SignatureAutomation, mandatory: true},
            10: {type: "int32", name: "position", ...PPQNPositionConstraints},
            21: {type: "int32", name: "nominator", constraints: "positive", unit: "", value: 4},
            22: {type: "int32", name: "denominator", constraints: "positive", unit: "", value: 4}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}