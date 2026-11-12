import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints} from "../../std/Defaults"

export const SamplerGroupBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SamplerGroupBox",
        fields: {
            1: {type: "pointer", name: "device", pointerType: Pointers.SamplerGroup, mandatory: true},
            2: {type: "field", name: "zones", pointerRules: {accepts: [Pointers.SamplerGroupZone], mandatory: false}},
            3: {type: "int32", name: "index", ...IndexConstraints},
            4: {type: "string", name: "label"},
            10: {
                type: "int32", name: "round-robin",
                value: 0, constraints: {values: [0, 1, 2]}, unit: "" // off, cycle, random
            },
            11: {type: "int32", name: "choke", value: 0, constraints: {min: 0, max: 127}, unit: ""}, // 0 is off
            12: {
                type: "int32", name: "trigger",
                value: 0, constraints: {values: [0, 1]}, unit: "" // attack, release
            }
        }
    },
    pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}
