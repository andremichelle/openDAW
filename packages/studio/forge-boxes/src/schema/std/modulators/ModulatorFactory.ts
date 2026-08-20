import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {Objects} from "@opendaw/lib-std"
import {IndexConstraints, ModulatorParameterPointerRules, UnipolarConstraints} from "../Defaults"

const ModulatorAttributes = {
    1: {type: "pointer", name: "collection", pointerType: Pointers.ModulatorCollection, mandatory: true},
    2: {type: "field", name: "assignments", pointerRules: {accepts: [Pointers.ModulatorSource], mandatory: false}},
    3: {type: "string", name: "label"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "int32", name: "index", ...IndexConstraints},
    6: {
        type: "field",
        name: "tracks",
        pointerRules: {accepts: [Pointers.TrackCollection], mandatory: false}
    },
    7: {type: "boolean", name: "bipolar", value: true},
    8: {
        type: "float32", name: "amount", pointerRules: ModulatorParameterPointerRules, value: 1.0,
        ...UnipolarConstraints
    },
    ...reserveMany(9)
} as const satisfies FieldRecord<Pointers>

export namespace ModulatorFactory {
    export const createModulator = <FIELDS extends FieldRecord<Pointers>>(
        name: string,
        fields: Objects.Disjoint<typeof ModulatorAttributes, FIELDS> & FieldRecord<Pointers>
    ): BoxSchema<Pointers> => {
        type DisjointFields = Objects.Disjoint<typeof ModulatorAttributes, FIELDS>
        return {
            type: "box",
            class: {name, fields: mergeFields(ModulatorAttributes, fields as DisjointFields)},
            pointerRules: {accepts: [Pointers.Selection, Pointers.MetaData], mandatory: false},
            tags: {type: "modulator"}
        }
    }
}
