// The reported hiccup: scrubbing back and forth across the delay/gate REORDER in test.odsl makes the delay
// "interpolate to a new offset / pitch as if created newly". A reorder is a pure `index` change, so the engine
// must REUSE the device processors (only rewire edges) — a rebuilt delay resets its DSP. This drives the REAL
// engine + device modules through the actual reorder transaction (step 117 swaps the delay & gate index) and
// asserts toggling it forward/back never reconstructs a device (`device_build_count` stays put).

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, Update, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../../../studio/core-wasm/src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("reorder does not rebuild devices", () => {
    it("toggling the delay/gate reorder reuses the processors", async () => {
        const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
        const {engine, memory, deviceBuilds} = await loadFullEngine()
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
        const a = new BroadcastChannel("reorder"); const b = new BroadcastChannel("reorder")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const sync = new SyncSource(source, Messenger.for(a), true)
        const tick = () => new Promise(resolve => setTimeout(resolve)) // drain the async ship before mutating source again
        await tick()
        engine.bind()

        // The reorder is step 117 (PRIMITIVE on both DelayDeviceBox and GateDeviceBox `index`, field 2). Drive
        // up to AT=117 (just before it), capturing the applied list per step so we can invert exactly.
        const REORDER = 117
        const applied: Array<ReadonlyArray<Update>> = []
        for (let at = 0; at < REORDER; at++) {
            applied[at] = stepForward(source, steps[at])
            await tick()
        }
        const buildsBeforeReorder = deviceBuilds()
        expect(buildsBeforeReorder).toBeGreaterThan(0) // the real devices (delay, gate, …) were built

        // Toggle ONLY the reorder forward/back several times. Each forward applies step 117 (the swap), each
        // backward inverts it. A correct engine reuses every processor, so no new device is constructed.
        const at = REORDER
        for (let round = 0; round < 6; round++) {
            applied[at] = stepForward(source, steps[at]) // apply the reorder (117 -> 118)
            await tick()
            stepBackward(source, applied[at])            // invert it (118 -> 117)
            await tick()
        }
        expect(deviceBuilds()).toBe(buildsBeforeReorder) // NO device was rebuilt by the reorder
    })
})
