import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const MidSideCompositeBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("MidSideCompositeBox", {
    10: {type: "field", name: "entries", pointerRules: {accepts: [Pointers.AudioEffectCompositeCell], mandatory: false}},
    11: {type: "field", name: "input", pointerRules: {accepts: [Pointers.SideChain], mandatory: false}},
    12: {
        type: "float32", name: "dry", pointerRules: ParameterPointerRules,
        value: Number.NEGATIVE_INFINITY, constraints: "decibel", unit: "dB"
    },
    13: {
        type: "float32", name: "wet", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    }
})
