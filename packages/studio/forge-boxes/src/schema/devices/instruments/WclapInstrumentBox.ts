import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const WclapInstrumentBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("WclapInstrumentBox", "notes", {
    10: {type: "string", name: "url"},
    11: {type: "string", name: "clap-id"},
    12: {type: "string", name: "state"}, // clap_plugin_state blob, base64
    13: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    // the source of each of the plugin's audio input ports (clap.audio-ports), in port order
    15: {
        type: "array", name: "audio-inputs", length: 8,
        element: {type: "pointer", pointerType: Pointers.SideChain, mandatory: false}
    }
})
