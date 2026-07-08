import {Maybe, UUID} from "@opendaw/lib-std"
import {AddressLayout} from "./address"
import {PrimitiveType} from "./primitive"

// WASM CONTRACT: these forward-only task tags ("new"/"update-primitive"/"update-pointer"/"delete")
// are serialized to the WASM engine and decoded by Rust (crates/boxgraph decode_forward). Do not rename.
// `primitiveType` carries the field's codec captured at emission time: a task stream is forward-only and
// self-contained, so serialization must never re-resolve the field against a live graph that a later task
// in the same batch may have deleted (e.g. undo trims a region, then unstages it — #287).
export type UpdateTask<M> =
    | { type: "new", name: keyof M, uuid: UUID.Bytes, buffer: ArrayBufferLike }
    | { type: "update-primitive", address: AddressLayout, primitiveType: PrimitiveType, value: unknown }
    | { type: "update-pointer", address: AddressLayout, target: Maybe<AddressLayout> }
    | { type: "delete", uuid: UUID.Bytes }

export interface Synchronization<M> {
    sendUpdates(updates: ReadonlyArray<UpdateTask<M>>): void
    checksum(value: Int8Array): Promise<void>
}