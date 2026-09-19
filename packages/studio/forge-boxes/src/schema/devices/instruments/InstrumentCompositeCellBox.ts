import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"

// One cell of a InstrumentCompositeBox: a generic wrapper that hosts ONE instrument plus its own midi / audio fx
// chains, the way an AudioUnit hosts an instrument and its chains (minus the channel strip). The instrument and
// the effects attach by their normal `host` pointers, so NO instrument or effect plugin changes to live inside
// a composite. The cell carries the chain fields; the composite reads this fixed layout (it is one box type, so
// the keys do not vary per instrument).
export const InstrumentCompositeCellBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "InstrumentCompositeCellBox",
        fields: {
            1: {type: "pointer", name: "composite", pointerType: Pointers.InstrumentCompositeCell, mandatory: true},
            2: {type: "field", name: "instrument", pointerRules: {accepts: [Pointers.InstrumentHost], mandatory: true}},
            3: {type: "field", name: "midi-effects", pointerRules: {accepts: [Pointers.MIDIEffectHost], mandatory: false}},
            4: {type: "field", name: "audio-effects", pointerRules: {accepts: [Pointers.AudioEffectHost], mandatory: false}},
            5: {type: "int32", name: "index", constraints: "index", unit: ""}, // position in the composite (UI order)
            6: {type: "string", name: "label"},
            7: {type: "boolean", name: "minimized", value: false},
            40: {
                type: "float32", name: "gain", pointerRules: ParameterPointerRules,
                value: 0.0, constraints: "decibel", unit: "dB"
            },
            41: {type: "boolean", name: "mute", pointerRules: ParameterPointerRules},
            42: {type: "boolean", name: "solo", pointerRules: ParameterPointerRules},
            43: {type: "float32", name: "pan", pointerRules: ParameterPointerRules, constraints: "bipolar", unit: ""}
        }
    },
    pointerRules: {accepts: [Pointers.Editing, Pointers.Selection], mandatory: false}
}
