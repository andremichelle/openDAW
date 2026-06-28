// The contract (your words): changing a plugin's index, OR adding / removing a plugin, must do NOTHING to the
// EXISTING plugins — no rebuild and no parameter re-push (a re-push glides e.g. the delay's offset). This
// drives the real engine + devices and toggles a plugin's chain membership (add <-> remove), asserting that a
// REMOVE pushes zero parameters and an ADD pushes a small, CONSTANT count (only the joiner's own), never
// scaling with / re-touching the survivors.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, Update, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const tick = () => new Promise(resolve => setTimeout(resolve))

describe("chain edit touches no existing plugin", () => {
    it("removing pushes no params; adding pushes only the joiner's", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
        const pushes = () => engine.param_push_count() >>> 0
        const builds = () => engine.device_build_count() >>> 0
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = new Uint8Array(serializeUpdateTasks(tasks, source))
                new Uint8Array(memory.buffer, engine.input_ptr(), bytes.length).set(bytes)
                expect(engine.apply_updates(bytes.length)).toBe(0)
            },
            checksum(): Promise<void> {return Promise.resolve()}
        }
        const a = new BroadcastChannel("cen"); const b = new BroadcastChannel("cen")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const sync = new SyncSource(source, Messenger.for(a), true)
        await tick(); engine.bind()

        // Drive only up to AT=96: the next transaction CREATES + connects the delay (an audio effect) onto a
        // unit that already has its instrument. So toggling step 96 adds / removes the delay while a survivor
        // (the unit's instrument) is present — exactly the "add a plugin, leave the others alone" case.
        const ADD = 96
        const applied: Array<ReadonlyArray<Update>> = []
        for (let at = 0; at < ADD; at++) {applied[at] = stepForward(source, steps[at]); await tick()}
        engine.play()
        for (let q = 0; q < 64; q++) {engine.render()}

        const deltas: Array<{addBuilds: number, addPush: number, removeBuilds: number, removePush: number}> = []
        for (let round = 0; round < 4; round++) {
            const p0 = pushes(); const b0 = builds()
            applied[ADD] = stepForward(source, steps[ADD]); await tick() // ADD the delay
            for (let q = 0; q < 16; q++) {engine.render()}
            const addPush = pushes() - p0; const addBuilds = builds() - b0
            const p1 = pushes(); const b1 = builds()
            stepBackward(source, applied[ADD]); await tick()             // REMOVE the delay
            for (let q = 0; q < 16; q++) {engine.render()}
            deltas.push({addBuilds, addPush, removeBuilds: builds() - b1, removePush: pushes() - p1})
        }
        console.log("per-cycle:", JSON.stringify(deltas))
        // REMOVE: nothing built, nothing pushed (the leaver is gone; every survivor is untouched).
        for (const {removeBuilds, removePush} of deltas) {expect(removeBuilds).toBe(0); expect(removePush).toBe(0)}
        // ADD builds exactly ONE device (the delay), and pushes EXACTLY the delay's own 13 parameters — and no
        // more. Before the fix, the joiner's initial param catch-up set `automation_dirty`, which made
        // `rebind_automation` re-observe + re-push EVERY plugin in the unit (its instrument too, via fresh
        // `last = NaN` handles), so this count would be 13 + the instrument's parameters. Now it is the joiner's
        // 13 alone — survivors are not touched, so a surviving delay never glides.
        const DELAY_PARAMS = 13
        for (const {addBuilds, addPush} of deltas) {expect(addBuilds).toBe(1); expect(addPush).toBe(DELAY_PARAMS)}
    })
})
