// Hammer the stepper with a fast-scrub barrage (many overlapping requests with jumping targets) while the
// engine sync is a real async pipeline, then assert it settles exactly on the final target with the engine
// checksum matching the source. Catches the driver restart race and any pipeline race a scrub can trigger.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {createStepper, decodeSteps, readCommits} from "../src/pages/sync-log/sync-log"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const WASM = path.resolve(__dirname, "../public/engine.wasm")

type EngineExports = {
    input_ptr(): number; checksum_ptr(): number
    init(sampleRate: number): void; bind(): number; apply_updates(len: number): number
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

describe("sync-log scrub", () => {
    it("settles on the final target after a fast-scrub barrage, engine in sync", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const checksum = (): Int8Array => new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice()
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks, source))
                new Uint8Array(memory.buffer, engine.input_ptr(), bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(): Promise<void> {return Promise.resolve()}
        }
        const a = new BroadcastChannel("scrub"); const b = new BroadcastChannel("scrub")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const syncSource = new SyncSource(source, Messenger.for(a), true)
        await tick()
        engine.bind()

        let current = 0
        const stepper = createStepper(source, steps, at => {current = at})

        // A barrage of jumping targets, mimicking a fast manual scrub (overlapping requests, varied timing).
        const targets = [40, 8, 55, 3, 70, 20, 90, 12, steps.length, 0, 33, steps.length]
        for (const t of targets) {
            stepper.request(t)
            await tick() // far faster than the driver settles, so requests overlap the running driver
        }
        const final = 17
        stepper.request(final)

        // Await the whole queued chain of traversals to drain — it visits every requested target in order and
        // settles on the final one. (Polling for `current === final` would exit early: the chain passes through
        // 17 transiently while traversing toward another target.)
        await stepper.whenIdle()
        expect(current).toBe(final)
        await tick(); await tick() // let the last transaction's engine apply drain
        expect(checksum()).toEqual(new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice())
        // The engine must match the source at the settled step.
        expect(Array.from(checksum())).toEqual(Array.from(new Int8Array(source.checksum())))
        console.log(`settled at ${current}; engine in sync`)
        stepper.dispose()
    })
})
