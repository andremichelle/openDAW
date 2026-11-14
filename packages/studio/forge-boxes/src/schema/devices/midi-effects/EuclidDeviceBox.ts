import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const EuclidDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("EuclidDeviceBox", {
    // which pattern plays, -1 is off. A change takes over at the next bar
    10: {type: "int32", name: "pattern", pointerRules: ParameterPointerRules, value: 0, constraints: {min: -1, max: 7}, unit: ""},
    // every lane restarts after this many steps of 1/16 at the global rate, 0 never
    11: {type: "int32", name: "length", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 128}, unit: ""},
    // ÷4, ÷2, ×1, ×2, ×4
    12: {type: "int32", name: "rate", pointerRules: ParameterPointerRules, value: 2, constraints: {length: 5}, unit: ""},
    13: {type: "int32", name: "seed", value: 1, constraints: {min: 0, max: 0x7FFFFFFF}, unit: ""},
    14: {type: "field", name: "lanes", pointerRules: {accepts: [Pointers.EuclidLane], mandatory: false}},
    20: {
        type: "array", name: "patterns", length: 8, element: {
            type: "object", class: {
                name: "EuclidPattern",
                fields: {1: {type: "pointer", name: "groove", pointerType: Pointers.Groove, mandatory: false}}
            }
        }
    }
})
