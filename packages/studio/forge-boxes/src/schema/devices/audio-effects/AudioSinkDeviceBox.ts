import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const AudioSinkDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("AudioSinkDeviceBox", {
    10: {
        type: "float32", name: "pass", pointerRules: ParameterPointerRules,
        value: Number.NEGATIVE_INFINITY, constraints: "decibel", unit: "dB"
    },
    11: {type: "pointer", name: "target-bus", pointerType: Pointers.AudioOutput, mandatory: false}
})
