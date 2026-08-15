import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, IndexConstraints, ParameterPointerRules, UnipolarConstraints} from "./Defaults"
import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Objects} from "@opendaw/lib-std"

// Shared by every modulator box, the per-kind attribute prefix DeviceFactory uses.
const ModulatorAttributes = {
    1: {type: "pointer", name: "collection", pointerType: Pointers.ModulatorCollection, mandatory: true},
    2: {type: "field", name: "assignments", pointerRules: {accepts: [Pointers.ModulatorSource], mandatory: false}},
    3: {type: "string", name: "label"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "int32", name: "index", ...IndexConstraints},
    ...reserveMany(6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

const createModulatorBox = <FIELDS extends FieldRecord<Pointers>>(
    name: string, fields: Objects.Disjoint<typeof ModulatorAttributes, FIELDS>): BoxSchema<Pointers> => ({
    type: "box",
    class: {name, fields: mergeFields(ModulatorAttributes, fields)},
    pointerRules: {accepts: [Pointers.Selection, Pointers.MetaData], mandatory: false}
})

export const LfoModulatorBox: BoxSchema<Pointers> = createModulatorBox("LfoModulatorBox", {
    10: {
        type: "int32", name: "shape", value: 0,
        constraints: {values: [0, 1, 2, 3]}, unit: "" // LfoShape
    },
    11: {
        type: "int32", name: "rate", value: 8, // LfoModulatorBoxAdapter.Rates, one bar
        constraints: {min: 0, max: 11}, unit: ""
    },
    12: {type: "float32", name: "phase", value: 0.0, ...UnipolarConstraints},
    13: {type: "float32", name: "amount", value: 1.0, ...UnipolarConstraints}
})

// Both pointers are mandatory, so deleting either end takes the assignment with it.
export const ModulationBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ModulationBox",
        fields: {
            1: {type: "pointer", name: "source", pointerType: Pointers.ModulatorSource, mandatory: true},
            2: {type: "pointer", name: "target", pointerType: Pointers.Modulation, mandatory: true},
            3: {
                type: "float32", name: "depth", pointerRules: ParameterPointerRules,
                value: 0.0, ...BipolarConstraints
            },
            4: {type: "boolean", name: "enabled", value: true},
            5: {type: "int32", name: "index", ...IndexConstraints}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}
