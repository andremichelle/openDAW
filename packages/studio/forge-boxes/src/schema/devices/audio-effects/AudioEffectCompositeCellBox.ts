import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"

// One ENTRY of an AudioEffectCompositeBox (a "layer"): a generic wrapper hosting its OWN audio-fx chain, the way a
// CompositeCellBox hosts an instrument plus its chains. The effects attach by their normal `host` pointers, so
// NO effect plugin changes to live inside a composite. Every entry reads the composite's input (distributed by
// the owning composite: broadcast, or split per channel for StereoCompositeBox) and its chain's output is mixed
// into the composite's wet sum through this cell's `gain`, gated by `mute` / `solo`. An entry has NO `enabled`
// of its own: mute IS the gate (and it is automatable, unlike a Playfield slot's structural `enabled`).
export const AudioEffectCompositeCellBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioEffectCompositeCellBox",
        fields: {
            1: {type: "pointer", name: "composite", pointerType: Pointers.AudioEffectCompositeCell, mandatory: true},
            2: {
                type: "field", name: "audio-effects",
                pointerRules: {accepts: [Pointers.AudioEffectHost], mandatory: false}
            },
            3: {type: "int32", name: "index", constraints: "index", unit: ""}, // position in the composite (UI order + sum order)
            4: {type: "string", name: "label"},
            5: {type: "boolean", name: "minimized", value: false},
            40: {
                type: "float32", name: "gain", pointerRules: ParameterPointerRules,
                value: 0.0, constraints: "decibel", unit: "dB"
            },
            41: {type: "boolean", name: "mute", pointerRules: ParameterPointerRules},
            42: {type: "boolean", name: "solo", pointerRules: ParameterPointerRules},
            // The entry's pan, applied by its ChannelStrip (the branch has its own strip). Bipolar, centre 0.
            43: {type: "float32", name: "pan", pointerRules: ParameterPointerRules, constraints: "bipolar", unit: ""}
        }
    },
    pointerRules: {accepts: [Pointers.Editing, Pointers.Selection], mandatory: false}
}
