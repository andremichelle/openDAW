import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"

export const UnknownAudioEffectDevice: BoxSchema<Pointers> =
    DeviceFactory.createAudioEffect("UnknownAudioEffectDeviceBox", {
        10: {type: "string", name: "comment"}
    })