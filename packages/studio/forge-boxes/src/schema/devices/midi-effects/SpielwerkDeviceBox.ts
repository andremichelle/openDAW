import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const SpielwerkDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("SpielwerkDeviceBox", {
    10: {type: "string", name: "code", value: ""},
    11: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    12: {type: "field", name: "samples", pointerRules: {accepts: [Pointers.Sample], mandatory: false}}
})
