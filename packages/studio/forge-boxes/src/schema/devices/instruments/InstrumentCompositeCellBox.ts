import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

// One cell of a CompositeDeviceBox: a generic wrapper that hosts ONE instrument plus its own midi / audio fx
// chains, the way an AudioUnit hosts an instrument and its chains (minus the channel strip). The instrument and
// the effects attach by their normal `host` pointers, so NO instrument or effect plugin changes to live inside
// a composite. The cell carries the chain fields; the composite reads this fixed layout (it is one box type, so
// the keys do not vary per instrument).
export const CompositeCellBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "CompositeCellBox",
        fields: {
            1: {type: "pointer", name: "composite", pointerType: Pointers.CompositeCell, mandatory: true},
            2: {type: "field", name: "instrument", pointerRules: {accepts: [Pointers.InstrumentHost], mandatory: true}},
            3: {type: "field", name: "midi-effects", pointerRules: {accepts: [Pointers.MIDIEffectHost], mandatory: false}},
            4: {type: "field", name: "audio-effects", pointerRules: {accepts: [Pointers.AudioEffectHost], mandatory: false}},
            5: {type: "int32", name: "index", constraints: "index", unit: ""} // position in the composite (UI order)
        }
    },
    pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}
