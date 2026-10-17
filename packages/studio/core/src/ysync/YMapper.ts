import {
    Address,
    ArrayField,
    Box,
    ByteArrayField,
    Field,
    Fields,
    ObjectField,
    PointerField,
    PrimitiveField,
    Vertex
} from "@opendaw/lib-box"
import * as Y from "yjs"
import {
    asDefined,
    assert,
    isDefined,
    isInstanceOf,
    isNotUndefined,
    isUndefined,
    JSONValue,
    UUID
} from "@opendaw/lib-std"

export namespace YMapper {
    export const createBoxMap = (box: Box): Y.Map<unknown> => {
        const map = new Y.Map()
        map.set("name", box.name)
        map.set("fields", createDeepMap(box.record()))
        return map
    }

    export const applyFromBoxMap = (box: Box, source: Y.Map<unknown>): void => {
        const apply = (vertex: Vertex, map: Y.Map<unknown>) => {
            const record = vertex.record()
            map.forEach((value, key) => {
                const field = record[key]
                if (isUndefined(field)) {return}
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
                        if (isNotUndefined(value)) {fromY(field, value)}
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

    // Yjs stores only Uint8Array as raw bytes, a view onto the same memory
    export const toY = (value: unknown): unknown =>
        value instanceof Int8Array ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value

    export const fromY = (field: PrimitiveField, value: unknown): void => {
        if (field instanceof ByteArrayField && !field.deprecated && value instanceof Uint8Array) {
            field.setValue(new Int8Array(value.buffer, value.byteOffset, value.byteLength))
        } else {
            field.fromJSON(value as JSONValue)
        }
    }

    export const findMap = (map: Y.Map<unknown>, fieldKeys: ReadonlyArray<string | number>): Y.Map<unknown> =>
        fieldKeys.reduce((map, key) => asDefined(map.get(String(key)), "Could not findMap") as Y.Map<unknown>, map)

    const createDeepMap = (struct: Readonly<Record<string, Field>>): Y.Map<unknown> => Object.entries(struct)
        .reduce((map, [key, field]) => {
            field.accept({
                visitPrimitiveField: (field: PrimitiveField): unknown => map.set(key,
                    field instanceof ByteArrayField && !field.deprecated ? toY(field.getValue()) : field.toJSON() ?? null),
                visitPointerField: (field: PointerField): unknown => map.set(key, field.toJSON() ?? null),
                visitArrayField: (field: ArrayField): unknown => map.set(key, createDeepMap(field.record())),
                visitObjectField: (field: ObjectField<any>): unknown => map.set(key, createDeepMap(field.record()))
            })
            return map
        }, new Y.Map())
}