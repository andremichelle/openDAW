import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const ZeitgeistDeviceBox: BoxSchema<Pointers> = DeviceFactory.createMidiEffect("ZeitgeistDeviceBox", {
    10: {type: "pointer", name: "groove", pointerType: Pointers.Groove, mandatory: true}
})