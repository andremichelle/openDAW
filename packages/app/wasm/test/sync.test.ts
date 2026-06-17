// End-to-end sync test: replay a recorded Sync Log (test-files/actions.odsl) on a main-thread
// BoxGraph through the REAL SyncSource, ship each transaction over a BroadcastChannel (async, like
// the worklet boundary) to the WASM audio-engine, and assert the engine's checksum matches the
// source graph after every transaction.
//
// The target bridge serializes SyncSource's forward-only UpdateTask[] into the byte stream the Rust
// engine's decode_forward consumes. Primitive value types are resolved from the source graph (the
// schema), which is exactly what the wasm would do from its own mirror.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {ByteArrayInput, ByteArrayOutput, isDefined, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Address, BoxGraph, PrimitiveField, PrimitiveValues, SyncSource, Synchronization, Updates, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

const ODSL = path.resolve(__dirname, "../../../../test-files/actions.odsl")
const WASM = path.resolve(__dirname, "../public/engine.wasm")

const COMMIT_INIT = 0
const COMMIT_UPDATES = 2

type Commit = {type: number, payload: ArrayBuffer}

const readCommits = (buffer: ArrayBuffer): ReadonlyArray<Commit> => {
    const input = new ByteArrayInput(buffer)
    const commits: Array<Commit> = []
    while (input.position < buffer.byteLength) {
        const type = input.readInt()
        input.readInt() // version
        input.readBytes(new Int8Array(32)) // prevHash
        input.readBytes(new Int8Array(32)) // thisHash
        const payload = new Int8Array(input.readInt())
        input.readBytes(payload)
        input.readDouble() // date
        commits.push({type, payload: payload.buffer})
    }
    return commits
}

type EngineExports = {
    memory: WebAssembly.Memory
    input_ptr(): number
    input_capacity(): number
    checksum_ptr(): number
    reset(): void
    apply_updates(len: number): number
}

const loadEngine = async (): Promise<EngineExports> => {
    const module = await WebAssembly.compile(readFileSync(WASM))
    const engine = new WebAssembly.Instance(module, {}).exports as unknown as EngineExports
    engine.reset()
    return engine
}

// Serialize SyncSource's forward-only UpdateTask[] into the stream decode_forward reads.
const serializeTasks = (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, source: BoxGraph<BoxIO.TypeMap>): ArrayBuffer => {
    const output = ByteArrayOutput.create()
    output.writeInt(tasks.length)
    tasks.forEach(task => {
        output.writeString(task.type)
        if (task.type === "new") {
            UUID.toDataOutput(output, task.uuid)
            output.writeString(task.name as string)
            output.writeInt(task.buffer.byteLength)
            output.writeBytes(new Int8Array(task.buffer))
        } else if (task.type === "update-primitive") {
            const address = Address.reconstruct(task.address)
            address.write(output)
            const field = source.findVertex(address).unwrap(() => `no field at ${address}`) as PrimitiveField
            const serialization = field.serialization()
            output.writeString(serialization.type)
            serialization.encode(output, task.value as PrimitiveValues)
        } else if (task.type === "update-pointer") {
            Address.reconstruct(task.address).write(output)
            if (isDefined(task.target)) {
                output.writeBoolean(true)
                Address.reconstruct(task.target).write(output)
            } else {
                output.writeBoolean(false)
            }
        } else if (task.type === "delete") {
            UUID.toDataOutput(output, task.uuid)
        }
    })
    return output.toArrayBuffer() as ArrayBuffer
}

const checksumsEqual = (left: Int8Array, right: Int8Array): boolean =>
    left.length === right.length && left.every((byte, index) => byte === right[index])

describe("sync: actions.odsl -> SyncSource -> wasm engine (checksum per transaction)", () => {
    it("matches the engine checksum after every transaction", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        expect(commits.length).toBeGreaterThan(1)
        expect(commits[0].type).toBe(COMMIT_INIT)

        const engine = await loadEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)

        const readEngineChecksum = (): Int8Array =>
            new Int8Array(engine.memory.buffer, engine.checksum_ptr(), 32).slice()

        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeTasks(tasks, source))
                expect(bytes.length).toBeLessThanOrEqual(engine.input_capacity())
                new Uint8Array(engine.memory.buffer, engine.input_ptr(), bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(value: Int8Array): Promise<void> {
                return checksumsEqual(value, readEngineChecksum())
                    ? Promise.resolve()
                    : Promise.reject(new Error("checksum mismatch between source graph and wasm engine"))
            }
        }

        const channelName = "engine-sync"
        const sourceChannel = new BroadcastChannel(channelName)
        const targetChannel = new BroadcastChannel(channelName)
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(targetChannel), target)
        const syncSource = new SyncSource(source, Messenger.for(sourceChannel), true)

        // initial sync (all boxes shipped as "new" by SyncSource initialize=true)
        await expect(syncSource.checksum(source.checksum())).resolves.toBeUndefined()

        let transactions = 0
        for (let index = 1; index < commits.length; index++) {
            const commit = commits[index]
            if (commit.type !== COMMIT_UPDATES) {continue}
            const updates = Updates.decode(new ByteArrayInput(commit.payload))
            source.beginTransaction()
            updates.forEach(update => update.forward(source))
            source.endTransaction()
            await expect(syncSource.checksum(source.checksum())).resolves.toBeUndefined()
            transactions++
        }
        expect(transactions).toBeGreaterThan(0)
        console.log(`validated initial sync + ${transactions} transactions; ${source.boxes().length} boxes`)

        syncSource.terminate()
        executor.terminate()
        sourceChannel.close()
        targetChannel.close()
    })
})
