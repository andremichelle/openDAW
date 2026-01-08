import {
    Address,
    ArrayField,
    Box,
    Field,
    Fields,
    ObjectField,
    PointerField,
    PrimitiveField,
    Vertex
} from "@opendaw/lib-box"
import * as Y from "yjs"
import {asDefined, assert, isDefined, isInstanceOf, isNotUndefined, JSONValue, UUID} from "@opendaw/lib-std"

export namespace YMapper {
    export const createBoxMap = (box: Box): Y.Map<unknown> => {
        const map = new Y.Map()
        map.set("name", box.name)
        map.set("fields", createDeepMap(box.record()))
        return map
    }

    export const applyFromBoxMap = (box: Box, source: Y.Map<unknown>): void => {
        const apply = (vertex: Vertex, map: Y.Map<unknown>) => {
            vertex.fields().forEach(field => {
                const value: unknown = map.get(String(field.fieldKey))
                field.accept({
                    visitArrayField: <FIELD extends Field>(field: ArrayField<FIELD>) => {
                        if (isInstanceOf(value, Y.Map)) {
                            apply(field, value)
                        }
                    },
                    visitObjectField: <FIELDS extends Fields>(field: ObjectField<FIELDS>) => {
                        if (isInstanceOf(value, Y.Map)) {
                            apply(field, value)
                        }
                    },
                    visitPointerField: (field: PointerField) => {
                        if (isNotUndefined(value)) {field.fromJSON(value as JSONValue)}
                    },
                    visitPrimitiveField: (field: PrimitiveField) => {
                        if (isNotUndefined(value)) {field.fromJSON(value as JSONValue)}
                    }
                })
            })
        }
        apply(box, source)
    }

    export const pathToAddress = ([uuidAsString, _, ...fieldKeysFromPath]: ReadonlyArray<string | number>, leafKey: string): Address => {
        assert(isDefined(uuidAsString), "Invalid path")
        const fieldKeys = new Int16Array(fieldKeysFromPath.length + 1)
        fieldKeysFromPath.forEach((key, index) => fieldKeys[index] = Number(key))
        fieldKeys[fieldKeysFromPath.length] = Number(leafKey)
        return new Address(UUID.parse(String(uuidAsString)), fieldKeys)
    }

    export const findMap = (map: Y.Map<unknown>, fieldKeys: ReadonlyArray<string | number>): Y.Map<unknown> =>
        fieldKeys.reduce((map, key) => asDefined(map.get(String(key)), "Could not findMap") as Y.Map<unknown>, map)

    const createDeepMap = (struct: Readonly<Record<string, Field>>): Y.Map<unknown> => Object.entries(struct)
        .reduce((map, [key, field]) => {
            field.accept({
                visitPrimitiveField: (field: PrimitiveField): unknown => map.set(key, field.toJSON() ?? null),
                visitPointerField: (field: PointerField): unknown => map.set(key, field.toJSON() ?? null),
                visitArrayField: (field: ArrayField): unknown => map.set(key, createDeepMap(field.record())),
                visitObjectField: (field: ObjectField<any>): unknown => map.set(key, createDeepMap(field.record()))
            })
            return map
        }, new Y.Map())
}