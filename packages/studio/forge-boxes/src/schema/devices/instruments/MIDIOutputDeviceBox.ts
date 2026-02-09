import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const MIDIOutputDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("MIDIOutputDeviceBox", {
    10: {
        // TODO deprecated. Use pointer (14) instead
        type: "object", name: "deprecated-device", deprecated: true, class: {
            name: "Device",
            fields: {
                1: {type: "string", name: "id"},
                2: {type: "string", name: "label"}
            }
        }
    },
    11: {type: "int32", name: "channel", constraints: {min: 0, max: 15}, unit: "ch"},
    12: {
        type: "int32", name: "deprecated-delay", deprecated: true,
        value: 10, constraints: "any", unit: "ms"
    },
    13: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    14: {type: "pointer", name: "device", pointerType: Pointers.MIDIDevice, mandatory: false}
})