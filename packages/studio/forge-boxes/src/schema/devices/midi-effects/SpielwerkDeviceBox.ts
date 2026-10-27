import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const SpielwerkDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("SpielwerkDeviceBox", {
    10: {type: "string", name: "code", value: ""},
    11: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    12: {type: "field", name: "samples", pointerRules: {accepts: [Pointers.Sample], mandatory: false}},
    14: {type: "field", name: "records", pointerRules: {accepts: [Pointers.ScriptRecord], mandatory: false}},
    15: {type: "field", name: "buffers", pointerRules: {accepts: [Pointers.ScriptBuffer], mandatory: false}}
})
