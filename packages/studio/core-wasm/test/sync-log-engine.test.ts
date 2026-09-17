// Drive the REAL engine.wasm through a Sync Log forward to the end, then backward to the start, asserting
// the engine's checksum tracks the source box graph at every step. Reproduces the runtime trap on rewind.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {ByteArrayInput} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepBackward, stepForward} from "./helpers/sync-log"

const ODSL = path.resolve(__dirname, "./fixtures/odsl/test.odsl")
const WASM = path.resolve(__dirname, "../dist/wasm/engine.wasm")

type EngineExports = {
    input_ptr(): number
    input_capacity(): number
    checksum_ptr(): number
    init(sampleRate: number): void
    bind(): number
    apply_updates(len: number): number
}

const loadEngine = async (): Promise<{engine: EngineExports, memory: WebAssembly.Memory}> => {
    const module = await WebAssembly.compile(readFileSync(WASM))
    const memory = new WebAssembly.Memory({initial: 256})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engine = new WebAssembly.Instance(module, {env: {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}})
        .exports as unknown as EngineExports
    engine.init(48000)
    return {engine, memory}
}

describe("sync-log engine: forward to end, backward to start", () => {
    it("the engine survives a full rewind", async () => {
        const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
        const {engine, memory} = await loadEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)

        const readChecksum = (): Int8Array => {
            const pointer = engine.checksum_ptr() // must re-run per read (lazy recompute); call BEFORE reading buffer
            return new Int8Array(memory.buffer, pointer, 32).slice()
        }
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks))
                const enginePtr2 = engine.input_ptr()
                new Uint8Array(memory.buffer, enginePtr2, bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(value: Int8Array): Promise<void> {
                return value.every((b, i) => b === readChecksum()[i])
                    ? Promise.resolve() : Promise.reject(new Error("checksum mismatch"))
            }
        }
        const sourceChannel = new BroadcastChannel("sl-engine")
        const targetChannel = new BroadcastChannel("sl-engine")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(targetChannel), target)
        const {SyncSource} = await import("@opendaw/lib-box")
        const syncSource = new SyncSource(source, Messenger.for(sourceChannel), true)
        await expect(syncSource.checksum(source.checksum())).resolves.toBeUndefined()
        engine.bind() // set up the master bus + reactive audio-unit reconcile (the path the page exercises)

        // FF, capturing the applied list per step; the engine checksum must track the source at every step.
        const applied = []
        for (let at = 0; at < steps.length; at++) {
            applied[at] = stepForward(source, steps[at])
            await expect(syncSource.checksum(source.checksum())).resolves.toBeUndefined()
        }
        // FR: rewind every step (this used to trap the engine when a per-note/-event monitor re-read a box
        // that the inverse delete had just removed).
        for (let at = steps.length; at > 0; at--) {
            stepBackward(source, applied[at - 1])
            await expect(syncSource.checksum(source.checksum())).resolves.toBeUndefined()
        }
        console.log("survived full forward + rewind")
    })
})
