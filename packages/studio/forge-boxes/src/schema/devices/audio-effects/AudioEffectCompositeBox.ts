import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

// A PARALLEL effect composite ("FX layers"): an audio effect that, instead of being a single leaf DSP, hosts a
// collection of ENTRIES (AudioEffectCompositeCellBox), each its own audio-fx chain. The composite's input is
// distributed to every entry, their outputs are mixed (each through the entry's own gain / mute / solo) into the
// wet sum, and the composite emits `dry * input + wet * wetSum`. Entries can hold composites, so stacks nest.
//
// `dry` defaults to SILENT (-inf dB) and `wet` to 0dB: the composite REPLACES the signal by default, raise `dry`
// for parallel-fx use. An EMPTY composite (zero entries) bypasses (identity pass-through) regardless of dry/wet,
// so inserting a fresh one never kills the chain.
//
// `input` (11) is a pointer-target vertex with no value: it is the composite's INPUT TAP, the address a nested
// device's sidechain points at to detect the signal ENTERING the composite. The engine registers the input copy
// there, so the tap survives replacing the plugin BEFORE the composite (the buffer is owned by the composite).
export const AudioEffectCompositeBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("AudioEffectCompositeBox", {
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
