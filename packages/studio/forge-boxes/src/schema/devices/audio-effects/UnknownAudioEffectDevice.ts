import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const UnknownAudioEffectDevice: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("UnknownAudioEffectDeviceBox", {
    10: {type: "string", name: "comment"}
})