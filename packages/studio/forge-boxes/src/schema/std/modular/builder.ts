import {Objects} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@moises-ai/lib-box-forge"

export const ModuleAttributes = {
    1: {
        type: "object", name: "attributes", class: {
            name: "ModuleAttributes",
            fields: {
                1: {type: "pointer", name: "collection", pointerType: Pointers.ModuleCollection, mandatory: true},
                2: {type: "string", name: "label"},
                3: {type: "int32", name: "x", constraints: "any", unit: "x"},
                4: {type: "int32", name: "y", constraints: "any", unit: "y"},
                5: {type: "boolean", name: "collapsed", value: false},
                6: {type: "boolean", name: "removable", value: true}
            }
        }
    },
    ...reserveMany(2, 3, 4, 5, 6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

export const createModule = <
    U extends typeof ModuleAttributes,
    V extends FieldRecord<Pointers>>(name: string, v: Objects.Disjoint<U, V>): BoxSchema<Pointers> => ({
    type: "box",
    class: {
        name,
        fields: mergeFields(ModuleAttributes, v)
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
})