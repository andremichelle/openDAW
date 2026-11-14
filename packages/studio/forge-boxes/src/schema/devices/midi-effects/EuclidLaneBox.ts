import {BoxSchema, FieldRecord} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints, MidiNoteConstraints, UnipolarConstraints} from "../../std/Defaults"

const int = (name: string, min: number, max: number, value: number) =>
    ({type: "int32", name, value, constraints: {min, max}, unit: ""} as const)

// the rhythm of one pattern, keys 10 + pattern * 10 + entry, flat so the device reads a lane as one table row
// patterns are named a to h, a field name cannot end in a digit
const rhythm = (pattern: number, name: string = "abcdefgh"[pattern]): FieldRecord<Pointers> => Object.fromEntries([
    int(`steps-${name}`, 1, 32, 16),
    int(`pulses-${name}`, 0, 32, 4),
    int(`rotate-${name}`, 0, 31, 0),
    // 1/4, 1/8, 1/16, 1/32, each straight, triplet, dotted
    int(`rate-${name}`, 0, 11, 6),
    int(`accents-${name}`, 0, 32, 0),
    int(`accent-rotate-${name}`, 0, 31, 0),
    int(`bursts-${name}`, 0, 32, 0),
    int(`burst-rotate-${name}`, 0, 31, 0),
    int(`repeats-${name}`, 2, 8, 3),
    {type: "float32", name: `fade-${name}`, value: 0.0, constraints: "bipolar", unit: "%"} as const
].map((field, entry) => [10 + pattern * 10 + entry, field])) as FieldRecord<Pointers>

// One lane: the note it plays and its rhythm in each of the eight patterns
export const EuclidLaneBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "EuclidLaneBox",
        fields: {
            1: {type: "pointer", name: "device", pointerType: Pointers.EuclidLane, mandatory: true},
            2: {type: "int32", name: "index", ...IndexConstraints},
            3: {type: "int32", name: "note", value: 60, ...MidiNoteConstraints},
            4: {type: "float32", name: "velocity", value: 0.5, ...UnipolarConstraints},
            5: {type: "float32", name: "chance", value: 1.0, ...UnipolarConstraints},
            // 0 a note lasts one step, 1 until the next hit
            6: {type: "int32", name: "gate", value: 0, constraints: {min: 0, max: 1}, unit: ""},
            7: {type: "boolean", name: "mute", value: false},
            8: {type: "boolean", name: "solo", value: false},
            ...Object.assign({}, ...Array.from({length: 8}, (_, pattern) => rhythm(pattern)))
        }
    },
    pointerRules: {accepts: [], mandatory: false}
}
