import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const SignatureEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SignatureEventBox",
        fields: {
            1: {type: "pointer", name: "events", pointerType: Pointers.SignatureAutomation, mandatory: true},
            9: {type: "int32", name: "index", constraints: "index", unit: "", value: 0},
            10: {type: "int32", name: "relative-position", constraints: "positive", unit: "bars", value: 1},
            21: {type: "int32", name: "nominator", constraints: "positive", unit: "", value: 4},
            22: {type: "int32", name: "denominator", constraints: "positive", unit: "", value: 4}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}