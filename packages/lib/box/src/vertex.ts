import {DataInput, DataOutput, JSONValue, Maybe, Option, Optional} from "@moises-ai/lib-std"
import {Addressable} from "./address"
import {Box} from "./box"
import {Field, Fields} from "./field"
import {PointerField, PointerTypes} from "./pointer"
import {PointerHub} from "./pointer-hub"
import {PrimitiveField} from "./primitive"
import {ArrayField} from "./array"
import {BoxGraph} from "./graph"
import {ObjectField} from "./object"

export interface PointerRules<P extends PointerTypes> {
    readonly accepts: ReadonlyArray<P>
    readonly mandatory: boolean
}

export const NoPointers: PointerRules<never> = Object.freeze({mandatory: false, accepts: []})

export interface VertexVisitor<RETURN = void> {
    visitArrayField?(field: ArrayField): RETURN
    visitObjectField?<FIELDS extends Fields>(field: ObjectField<FIELDS>): RETURN
    visitPointerField?(field: PointerField): RETURN
    visitPrimitiveField?(field: PrimitiveField): RETURN
    visitField?(field: Field): RETURN
}

export interface Visitable {
    accept<VISITOR extends VertexVisitor<any>>(visitor: VISITOR): VISITOR extends VertexVisitor<infer R> ? Maybe<R> : void
}

export interface Vertex<P extends PointerTypes = PointerTypes, F extends Fields = any> extends Addressable, Visitable {
    get box(): Box
    get graph(): BoxGraph
    get parent(): Vertex
    get pointerHub(): PointerHub
    get pointerRules(): PointerRules<P>

    isBox(): this is Box
    isField(): this is Field
    isAttached(): boolean
    fields(): ReadonlyArray<Field>
    record(): Readonly<Record<string, Field>>
    getField(key: keyof F): F[keyof F]
    optField(key: keyof F): Option<F[keyof F]>
    read(input: DataInput): void
    write(output: DataOutput): void
    toJSON(): Optional<JSONValue>
    fromJSON(value: JSONValue): void
}