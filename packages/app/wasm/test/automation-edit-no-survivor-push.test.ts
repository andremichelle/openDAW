// Editing ONE parameter of a plugin must push ONLY that parameter to ONLY that plugin — never re-push the
// other plugins in the unit (which would glide e.g. a surviving delay). This drives the real engine + devices,
// changes the delay's `feedback` field, and asserts exactly ONE parameter push results.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, DelayDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const tick = () => new Promise(resolve => setTimeout(resolve))

describe("editing one parameter touches no other plugin", () => {
    it("changing the delay's feedback pushes exactly one parameter", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
        const pushes = () => engine.param_push_count() >>> 0
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
        const a = new BroadcastChannel("aen"); const b = new BroadcastChannel("aen")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const sync = new SyncSource(source, Messenger.for(a), true)
        await tick(); engine.bind()

        // Build the whole project (the delay is live in a unit that also has an instrument + other plugins).
        for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await tick()}
        engine.play()
        for (let q = 0; q < 64; q++) {engine.render()}

        const delay = source.boxes().find((box): box is DelayDeviceBox => box instanceof DelayDeviceBox)
        expect(delay).toBeDefined()

        // Change ONE parameter (feedback). This sets the unit's automation-dirty flag, which re-binds the unit's
        // automation. It must push ONLY the changed feedback parameter — not the delay's other 12 params, and
        // not the instrument's params (before the fix it re-pushed every parameter in the unit via fresh handles).
        const before = delay!.feedback.getValue()
        const p0 = pushes()
        source.beginTransaction()
        delay!.feedback.setValue(before < 0.5 ? 0.7 : 0.3)
        source.endTransaction()
        await tick()
        for (let q = 0; q < 16; q++) {engine.render()}
        console.log(`param pushes from a single feedback edit: ${pushes() - p0}`)
        expect(pushes() - p0).toBe(1)
    })
})
