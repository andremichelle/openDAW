import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {Objects} from "@opendaw/lib-std"
import {IndexConstraints} from "../Defaults"

const ModulatorAttributes = {
    1: {type: "pointer", name: "collection", pointerType: Pointers.ModulatorCollection, mandatory: true},
    2: {type: "field", name: "assignments", pointerRules: {accepts: [Pointers.ModulatorSource], mandatory: false}},
    3: {type: "string", name: "label"},
    4: {type: "boolean", name: "enabled", value: true},
    5: {type: "int32", name: "index", ...IndexConstraints},
    ...reserveMany(6, 7, 8, 9)
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
