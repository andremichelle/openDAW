import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const WclapDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("WclapDeviceBox", {
    10: {type: "string", name: "url"},
    11: {type: "string", name: "clap-id"},
    12: {type: "string", name: "state"}, // legacy clap_plugin_state as base64, read only while plugin-state is empty
    13: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    14: {type: "bytes", name: "plugin-state"}
})
