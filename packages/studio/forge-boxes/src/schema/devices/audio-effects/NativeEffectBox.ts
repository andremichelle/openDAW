import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

// a native plugin effect, hosted by the desktop app only; elsewhere the audio passes through and it keeps its fields
export const NativeEffectBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("NativeEffectBox", {
    10: {type: "string", name: "format"},
    11: {type: "string", name: "plugin-id"},
    12: {type: "bytes", name: "state"},
    13: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    14: {type: "string", name: "plugin-name"},
    15: {type: "string", name: "vendor"}
})
