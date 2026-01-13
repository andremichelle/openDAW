import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const SoundfontDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("SoundfontDeviceBox", {
    10: {type: "pointer", name: "file", pointerType: Pointers.SoundfontFile, mandatory: false},
    11: {type: "int32", name: "preset-index", constraints: {min: 0, max: 65535}, unit: ""}
})