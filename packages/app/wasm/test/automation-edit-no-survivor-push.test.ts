// Editing ONE parameter of a plugin must push ONLY that parameter to ONLY that plugin — never re-push the
// other plugins in the unit (which would glide e.g. a surviving delay). This drives the real engine + devices,
// changes the delay's `feedback` field, and asserts exactly ONE parameter push results.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {DelayDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("editing one parameter touches no other plugin", () => {
    it("changing the delay's feedback pushes exactly one parameter", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
        const pushes = () => engine.param_push_count() >>> 0
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind()

        // Build the whole project (the delay is live in a unit that also has an instrument + other plugins).
        for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await sync.settle()}
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
        await sync.settle()
        for (let q = 0; q < 16; q++) {engine.render()}
        console.log(`param pushes from a single feedback edit: ${pushes() - p0}`)
        expect(pushes() - p0).toBe(1)
    })
})
