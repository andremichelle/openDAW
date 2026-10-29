import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

// the field keys of WclapDeviceBox, so the engine's WclapLink and the studio's wclap services serve it unchanged
export const WclapMidiEffectBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("WclapMidiEffectBox", {
    10: {type: "string", name: "url"},
    11: {type: "string", name: "clap-id"},
    12: {type: "string", name: "state"}, // never written, WclapLink observes it like on the other WebCLAP boxes
    13: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    14: {type: "bytes", name: "plugin-state"}
})
