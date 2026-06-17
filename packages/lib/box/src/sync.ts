import {Maybe, UUID} from "@opendaw/lib-std"
import {AddressLayout} from "./address"

// WASM CONTRACT: these forward-only task tags ("new"/"update-primitive"/"update-pointer"/"delete")
// are serialized to the WASM engine and decoded by Rust (crates/boxgraph decode_forward). Do not rename.
export type UpdateTask<M> =
    | { type: "new", name: keyof M, uuid: UUID.Bytes, buffer: ArrayBufferLike }
    | { type: "update-primitive", address: AddressLayout, value: unknown }
    | { type: "update-pointer", address: AddressLayout, target: Maybe<AddressLayout> }
    | { type: "delete", uuid: UUID.Bytes }

export interface Synchronization<M> {
    sendUpdates(updates: ReadonlyArray<UpdateTask<M>>): void
    checksum(value: Int8Array): Promise<void>
}