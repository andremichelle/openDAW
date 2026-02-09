import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "./Defaults"
import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {PPQN} from "@moises-ai/lib-dsp"
import {Objects} from "@moises-ai/lib-std"

const GrooveBoxAttributes = {
    1: {type: "string", name: "label"},
    ...reserveMany(2, 3, 4, 5, 6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

const createGrooveBox = <FIELDS extends FieldRecord<Pointers>>(
    name: string, fields: Objects.Disjoint<typeof GrooveBoxAttributes, FIELDS>): BoxSchema<Pointers> => ({
    type: "box",
    class: {name, fields: mergeFields(GrooveBoxAttributes, fields)},
    pointerRules: {mandatory: true, accepts: [Pointers.Groove]}
})

export const GrooveShuffleBox: BoxSchema<Pointers> = createGrooveBox("GrooveShuffleBox", {
    10: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 0.6, ...UnipolarConstraints
    },
    11: {
        type: "int32", name: "duration", pointerRules: ParameterPointerRules,
        value: PPQN.fromSignature(1, 8),
        constraints: "non-negative", unit: "ppqn"
    }
})

export const GrooveOffsetBox: BoxSchema<Pointers> = createGrooveBox("GrooveOffsetBox", {
    10: {
        type: "float32",
        name: "amount",
        pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints
    },
    11: {
        type: "boolean",
        name: "sync",
        pointerRules: ParameterPointerRules,
        value: true
    }
})