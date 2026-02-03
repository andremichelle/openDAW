import {float, Func, int, Objects} from "@opendaw/lib-std"
import {Constraints, FieldKey, PointerRules, PointerTypes} from "@opendaw/lib-box"

export const reserved = Object.freeze({type: "reserved", name: ""} as const)

export const deprecated = true

type ReservedType = typeof reserved

export const reserveMany = <Keys extends int[]>(..._keys: Keys): Record<Keys[int], ReservedType> =>
    ({} as Record<Keys[int], ReservedType>)

export type FieldName = {
    name: string
}
export type Referencable<E extends PointerTypes> = {
    pointerRules?: PointerRules<E>
}
export type Schema<E extends PointerTypes> = {
    path: string // the path to the folder to output the TypeScript files
    pointers: {
        from: string // the path to the pointer-type enum
        enum: string // the name of the exported pointer-type enum
        print: Func<E, string> // a function that turns the enum value into source code (Ptr.A > "Ptr.A")
    }
    boxes: ReadonlyArray<BoxSchema<E>>
}
export type FieldRecord<E extends PointerTypes> = {
    [K in FieldKey]: AnyField<E> & FieldName
}
export type ClassSchema<E extends PointerTypes> = {
    name: string
    fields: FieldRecord<E>
}
// Resources act as leaves when collecting dependencies (their own dependencies are not followed).
// "preserved": UUID is preserved during copy/paste (for content-addressable storage like audio files)
// "internal": UUID is regenerated during copy/paste
export type ResourceType = "preserved" | "internal"

export type BoxSchema<E extends PointerTypes> = Referencable<E> & {
    type: "box"
    class: ClassSchema<E>
    ephemeral?: boolean
    resource?: ResourceType
    tags?: Record<string, string | number | boolean>
}
export type ObjectSchema<E extends PointerTypes> = {
    type: "object"
    class: ClassSchema<E>
}
export type ArrayFieldSchema<E extends PointerTypes> = {
    type: "array",
    element: AnyField<E>
    length: int
}
export type PointerFieldSchema<E extends PointerTypes> = {
    type: "pointer"
    pointerType: E
    mandatory: boolean
}

export type Int32FieldSchema<E extends PointerTypes> = Referencable<E> & {
    type: "int32"
    value?: int
    unit: string
    constraints: Constraints.Int32
}

/**
 * constraints:
 *  decibel referes to default decible mapping decibel(-72.0, -12.0, 0.0)
 *  @see @opendaw/lib-std/src/value-mapping.ts
 */
export type Float32FieldSchema<E extends PointerTypes> = Referencable<E> & {
    type: "float32"
    value?: float
    unit: string
    constraints: Constraints.Float32
}

export type BooleanFieldSchema<E extends PointerTypes> = Referencable<E> & {
    type: "boolean"
    value?: boolean
}

export type StringFieldSchema<E extends PointerTypes> = Referencable<E> & {
    type: "string"
    value?: string
}

export type BytesFieldSchema<E extends PointerTypes> = Referencable<E> & {
    type: "bytes"
    value?: Int8Array
}

export type PrimitiveFieldSchema<E extends PointerTypes> =
    | Int32FieldSchema<E>
    | Float32FieldSchema<E>
    | BooleanFieldSchema<E>
    | StringFieldSchema<E>
    | BytesFieldSchema<E>

export type FieldSchema<E extends PointerTypes> = Required<Referencable<E>> & {
    type: "field"
}
export type AnyField<E extends PointerTypes> = (
        | FieldSchema<E>
        | PointerFieldSchema<E>
        | PrimitiveFieldSchema<E>
        | ArrayFieldSchema<E>
        | ObjectSchema<E>
        | typeof reserved)
    & { deprecated?: true }

// utility methods to build schema
//
export const mergeFields =
    <E extends PointerTypes, U extends FieldRecord<E>, V extends FieldRecord<E>>(
        u: U, v: Objects.Disjoint<U, V>): U & V => Objects.mergeNoOverlap(u, v)