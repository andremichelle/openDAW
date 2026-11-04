import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints, ParameterPointerRules, UnipolarConstraints} from "./Defaults"
import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {PPQN} from "@opendaw/lib-dsp"
import {Objects} from "@opendaw/lib-std"

const GrooveBoxAttributes = {
    1: {type: "string", name: "label"},
    2: {type: "pointer", name: "collection", pointerType: Pointers.GrooveCollection, mandatory: false},
    3: {type: "int32", name: "index", ...IndexConstraints},
    ...reserveMany(4, 5, 6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

const createGrooveBox = <FIELDS extends FieldRecord<Pointers>>(
    name: string, fields: Objects.Disjoint<typeof GrooveBoxAttributes, FIELDS>): BoxSchema<Pointers> => ({
    type: "box",
    class: {name, fields: mergeFields(GrooveBoxAttributes, fields)},
    pointerRules: {mandatory: false, accepts: [Pointers.Groove, Pointers.Selection]},
    resource: "internal",
    tags: {type: "groove"}
})

const GrooveDuration = (value: number) => ({
    type: "int32", name: "duration", pointerRules: ParameterPointerRules, value,
    constraints: "non-negative", unit: "ppqn"
} as const)

export const GrooveShuffleBox: BoxSchema<Pointers> = createGrooveBox("GrooveShuffleBox", {
    10: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 0.6, ...UnipolarConstraints
    },
    11: GrooveDuration(PPQN.fromSignature(1, 8))
})

export const GrooveFunctionBox: BoxSchema<Pointers> = createGrooveBox("GrooveFunctionBox", {
    10: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 0.75, ...UnipolarConstraints
    },
    11: GrooveDuration(PPQN.fromSignature(1, 4)),
    12: {
        type: "int32", name: "function", value: 0,
        constraints: {values: [0, 1]}, unit: "" // GrooveFunctionType: 0 power, 1 s-curve
    }
})

export const GrooveRandomBox: BoxSchema<Pointers> = createGrooveBox("GrooveRandomBox", {
    10: {
        type: "float32", name: "amount", pointerRules: ParameterPointerRules,
        value: 0.75, ...UnipolarConstraints
    },
    11: GrooveDuration(PPQN.fromSignature(1, 1)),
    12: {type: "int32", name: "seed", value: 1, constraints: {min: 0, max: 999999}, unit: ""},
    13: {
        type: "float32", name: "roughness", pointerRules: ParameterPointerRules,
        value: 1.0, ...UnipolarConstraints
    },
    14: {
        type: "int32", name: "steps", pointerRules: ParameterPointerRules, value: 64,
        constraints: {min: 2, max: 64}, unit: ""
    }
})

export const GrooveStackBox: BoxSchema<Pointers> = createGrooveBox("GrooveStackBox", {
    10: {
        type: "field", name: "entries",
        pointerRules: {accepts: [Pointers.GrooveStackEntries], mandatory: false}
    }
})

export const GrooveStackEntryBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "GrooveStackEntryBox",
        fields: {
            1: {type: "pointer", name: "stack", pointerType: Pointers.GrooveStackEntries, mandatory: true},
            2: {type: "pointer", name: "groove", pointerType: Pointers.Groove, mandatory: true},
            3: {type: "int32", name: "index", ...IndexConstraints}
        }
    },
    resource: "internal"
}

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
