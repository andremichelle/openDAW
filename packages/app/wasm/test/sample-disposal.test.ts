// Drive the real engine.wasm through a Sync Log, replicating the worklet's sample-load handshake with
// real PCM allocations, and assert the engine FREES that memory when the AudioFileBoxes are deleted on
// rewind. Guards the dropped-delete-name bug: the wire delete task carries only the uuid, so the engine
// must resolve the box name from its own graph for the AudioFileBox free observer to fire.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../../../studio/core-wasm/src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const WASM = path.resolve(__dirname, "../public/wasm/engine.wasm")

type EngineExports = {
    input_ptr(): number; input_reserve(len: number): number; checksum_ptr(): number
    init(sampleRate: number): void; bind(): number; apply_updates(len: number): number
    heap_used(): number
    sample_take_request(outPtr: number): number
    sample_allocate(handle: number, byteLength: number): number
    sample_set_ready(handle: number, frameCount: number, channelCount: number, sampleRate: number): void
}

const loadEngine = async () => {
    const module = await WebAssembly.compile(readFileSync(WASM))
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engine = new WebAssembly.Instance(module, {env: {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}})
        .exports as unknown as EngineExports
    engine.init(48000)
    return {engine, memory}
}

const tick = () => new Promise(resolve => setTimeout(resolve))

describe("sample disposal", () => {
    it("frees sample PCM when the AudioFileBoxes are deleted on rewind", async () => {
        const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
        const {engine, memory} = await loadEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks))
                new Uint8Array(memory.buffer, engine.input_ptr(), bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(): Promise<void> {return Promise.resolve()}
        }
        const a = new BroadcastChannel("disposal"); const b = new BroadcastChannel("disposal")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const sync = new SyncSource(source, Messenger.for(a), true)
        await tick()
        engine.bind()
        // Replicate the worklet handshake, allocating real PCM (256 KiB per sample) synchronously.
        const BYTES = 256 * 1024
        const drain = (): number => {
            let loaded = 0
            for (; ;) {
                const outPtr = engine.input_reserve(16)
                const handle = engine.sample_take_request(outPtr)
                if (handle < 0) {break}
                engine.sample_allocate(handle, BYTES)
                engine.sample_set_ready(handle, BYTES / 8, 2, 48000)
                loaded++
            }
            return loaded
        }
        const baseline = engine.heap_used()
        const applied: Array<ReadonlyArray<import("@opendaw/lib-box").Update>> = []
        let loadedTotal = 0
        for (let at = 0; at < steps.length; at++) {
            applied[at] = stepForward(source, steps[at])
            await tick()
            loadedTotal += drain()
        }
        expect(loadedTotal).toBeGreaterThan(0) // the log really does load samples (the 808 set)
        const peak = engine.heap_used()
        expect(peak - baseline).toBeGreaterThan(loadedTotal * BYTES * 0.9) // the PCM is resident
        for (let at = steps.length; at > 0; at--) {
            stepBackward(source, applied[at - 1])
            await tick()
        }
        const rewound = engine.heap_used()
        // After a full rewind every AudioFileBox is gone, so its PCM must be freed: heap returns to ~baseline,
        // NOT baseline + the loaded PCM. Allow a small structural margin; without the fix ~all PCM leaks.
        expect(rewound - baseline).toBeLessThan(loadedTotal * BYTES * 0.1)
    })
})
