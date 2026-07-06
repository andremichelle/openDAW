// Regression: SyncSource batches must be serialized AT EMISSION TIME. The studio's previous wiring pushed
// the update tasks over a MessageChannel loopback, so serialization ran a macrotask later against the LIVE
// graph: a transaction updating a field followed by a transaction deleting that box IN THE SAME TASK made
// the deferred `findVertex(address)` unwrap fail, dropping the whole batch and silently desyncing the
// engine mirror. The synchronous loopback serializes each batch within the endTransaction call stack.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {Communicator} from "@opendaw/lib-runtime"
import {BoxGraph, SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {createSyncLoopback} from "../src/sync/loopback"

const WASM = path.resolve(__dirname, "../public/wasm/engine.wasm")

type EngineExports = {
    input_reserve(len: number): number
    checksum_ptr(): number
    init(sampleRate: number): void
    apply_updates(len: number): number
}

const loadEngine = async (): Promise<{engine: EngineExports, memory: WebAssembly.Memory}> => {
    const module = await WebAssembly.compile(readFileSync(WASM))
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engine = new WebAssembly.Instance(module, {env: {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}})
        .exports as unknown as EngineExports
    engine.init(48000)
    return {engine, memory}
}

describe("sync: serialization happens at task emission time", () => {
    it("keeps a field-update batch intact when the next transaction deletes the box in the same task", async () => {
        const {engine, memory} = await loadEngine()
        const source = new BoxGraph<BoxIO.TypeMap>()
        source.beginTransaction()
        const collection = ValueEventCollectionBox.create(source, UUID.generate())
        const event = ValueEventBox.create(source, UUID.generate(), box => {
            box.events.refer(collection.events)
            box.position.setValue(0)
            box.index.setValue(0)
            box.value.setValue(0.25)
        })
        source.endTransaction()
        const batches: Array<ArrayBuffer> = []
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates: (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void => {
                batches.push(serializeUpdateTasks(tasks, source))
            },
            checksum: (_value: Int8Array): Promise<void> => Promise.resolve()
        }
        const loopback = createSyncLoopback()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(loopback.target, target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(source, loopback.source, true)
        expect(batches.length).toBe(1) // the initial full dump arrived synchronously
        // The race this test pins down: update a primitive field, then delete the box in the NEXT
        // transaction WITHOUT yielding to the event loop in between. Deferred serialization would resolve
        // the update-primitive codec against the already-deleted box and drop the first batch.
        source.beginTransaction()
        event.value.setValue(0.75)
        source.endTransaction()
        source.beginTransaction()
        event.delete()
        source.endTransaction()
        expect(batches.length).toBe(3)
        batches.forEach(batch => expect(batch.byteLength).toBeGreaterThan(4))
        // The engine must accept every batch in order and end up mirroring the source graph exactly.
        batches.forEach(batch => {
            const bytes = new Uint8Array(batch)
            const pointer = engine.input_reserve(bytes.length)
            new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
            expect(engine.apply_updates(bytes.length)).toBe(0)
        })
        const engineChecksum = new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice()
        const sourceChecksum = source.checksum()
        expect(Array.from(engineChecksum)).toEqual(Array.from(sourceChecksum))
        syncSource.terminate()
        executor.terminate()
        loopback.terminate()
    })
})
