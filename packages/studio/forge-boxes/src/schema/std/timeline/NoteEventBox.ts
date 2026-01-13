import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {PPQN} from "@moises-ai/lib-dsp"
import {
    BipolarConstraints,
    MidiNoteConstraints,
    PPQNDurationConstraints,
    PPQNPositionConstraints,
    UnipolarConstraints
} from "../Defaults"

export const NoteEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteEventBox",
        fields: {
            1: {type: "pointer", name: "events", pointerType: Pointers.NoteEvents, mandatory: true},
            10: {type: "int32", name: "position", ...PPQNPositionConstraints},
            11: {type: "int32", name: "duration", value: PPQN.SemiQuaver, ...PPQNDurationConstraints}, // [1...]
            20: {type: "int32", name: "pitch", value: 60, ...MidiNoteConstraints}, // [0...127]
            21: {type: "float32", name: "velocity", value: 100.0 / 127.0, ...UnipolarConstraints}, // [0...1]
            22: {type: "int32", name: "play-count", value: 1, constraints: {min: 1, max: 128}, unit: ""}, // [1...128]
            23: {type: "float32", name: "play-curve", value: 0.0, ...BipolarConstraints}, // [-1...1]
            24: {
                type: "float32", name: "cent",
                value: 0, constraints: {min: -50.0, max: 50.0, scaling: "linear"}, unit: "ct"
            },
            25: {type: "int32", name: "chance", value: 100, constraints: {min: 0, max: 100}, unit: ""} // [1...100]
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.NoteEventFeature], mandatory: false}
}