import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const WclapInstrumentBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("WclapInstrumentBox", "notes", {
    10: {type: "string", name: "url"},
    11: {type: "string", name: "clap-id"},
    12: {type: "string", name: "state"} // clap_plugin_state blob, base64
})
