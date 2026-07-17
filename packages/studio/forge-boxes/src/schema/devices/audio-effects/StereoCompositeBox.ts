import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

// A stereo SPLIT composite: the same shape as AudioEffectCompositeBox (identical field keys, the same
// AudioEffectCompositeCellBox entries), but its input DISTRIBUTOR splits the signal per channel instead of
// broadcasting it — entry 0 receives left, entry 1 receives right, and the wet sum recombines them. It is its
// own box type purely so the engine's spec selects the stereo distributor; everything else is shared.
//
// Its factory creates exactly TWO fixed entries (L / R), which the UI does not let the user add to or remove.
// This is the first of the split containers (freq / mid-side / tonal follow as further box types on the same
// distributor seam), so it proves that seam end-to-end.
export const StereoCompositeBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("StereoCompositeBox", {
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
