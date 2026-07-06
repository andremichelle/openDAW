// Wires a source BoxGraph to a loaded engine through the unchanged SyncSource (over a BroadcastChannel
// loopback), exactly as the app does, and exposes a DETERMINISTIC drain: `settle()`.
//
// Why this exists: a transaction ships asynchronously (SyncSource -> channel -> serialize -> apply_updates).
// `await new Promise(r => setTimeout(r))` does NOT reliably wait for that round-trip, so a test that mutates
// the source again too soon makes the serializer read a half-advanced graph (an Option unwrap blows up) — the
// intermittent integration-test flake. `settle()` instead awaits a checksum RPC, which the channel delivers
// AFTER the update messages (FIFO), so it resolves only once every queued update has been serialized + applied.
// It also asserts the engine's checksum tracks the source, so a desync fails loudly instead of silently.

import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {serializeUpdateTasks} from "../../../../studio/core-wasm/src/sync/serialize-update-tasks"

export type EngineSync = {
    // Drain every shipped transaction into the engine and assert the engine checksum equals the source's.
    settle(): Promise<void>
    close(): void
}

type SyncEngine = {
    input_reserve(len: number): number
    checksum_ptr(): number
    apply_updates(len: number): number
}

let channelCounter = 0

export const connectSyncToEngine = (engine: SyncEngine, memory: WebAssembly.Memory,
                                    source: {checksum(): Int8Array}): EngineSync => {
    const channelName = `engine-sync-${channelCounter++}`
    const engineChecksum = (): Int8Array => new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice()
    const target: Synchronization<BoxIO.TypeMap> = {
        sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
            const bytes = new Uint8Array(serializeUpdateTasks(tasks, source as never))
            const pointer = engine.input_reserve(bytes.length)
            new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
            if (engine.apply_updates(bytes.length) !== 0) {throw new Error("apply_updates rejected a transaction")}
        },
        checksum(value: Int8Array): Promise<void> {
            const actual = engineChecksum()
            return value.every((byte, index) => byte === actual[index])
                ? Promise.resolve()
                : Promise.reject(new Error("engine checksum diverged from the source"))
        }
    }
    const a = new BroadcastChannel(channelName)
    const b = new BroadcastChannel(channelName)
    Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
    const syncSource = new SyncSource<BoxIO.TypeMap>(source as never, Messenger.for(a), true)
    return {
        settle: () => syncSource.checksum(source.checksum()),
        close: () => {a.close(); b.close()}
    }
}
