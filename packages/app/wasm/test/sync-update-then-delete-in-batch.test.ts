// Regression (#287): a single transaction may update a primitive field AND then delete that box — the
// exact shape an UNDO produces when it inverse-trims a region (setValue on duration/loopOffset/loopDuration)
// and then unstages it. SyncSource collects both as one forward-only batch: [update-primitive .../11, ...,
// delete uuid]. serializeUpdateTasks used to re-resolve each field's codec from the LIVE graph via
// findVertex, which is empty for the just-deleted box -> "no field at <uuid>/11", throwing out of
// endTransaction (surfaced as "History changed by another participant") and poisoning the next batch.
// The task now carries its primitiveType from emission, so the stream is self-contained and the engine
// applies update-then-delete in order, ending up mirroring the source exactly.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {Communicator} from "@opendaw/lib-runtime"
import {BoxGraph, SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {serializeUpdateTasks} from "../../../studio/core-wasm/src/sync/serialize-update-tasks"
import {createSyncLoopback} from "../../../studio/core-wasm/src/sync/loopback"

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

describe("sync: update-primitive followed by delete in the SAME transaction (#287)", () => {
    it("serializes the batch and keeps the engine mirroring the source", async () => {
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
                batches.push(serializeUpdateTasks(tasks))
            },
            checksum: (_value: Int8Array): Promise<void> => Promise.resolve()
        }
        const loopback = createSyncLoopback()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(loopback.target, target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(source, loopback.source, true)
        expect(batches.length).toBe(1) // initial full dump
        // The #287 shape: mutate the field AND delete the box within ONE transaction. Without the fix,
        // serializeUpdateTasks throws "no field at <uuid>/..." here (the box is gone at flush time).
        source.beginTransaction()
        event.value.setValue(0.75)
        event.delete()
        source.endTransaction()
        expect(batches.length).toBe(2)
        batches.forEach(batch => expect(batch.byteLength).toBeGreaterThan(4))
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
