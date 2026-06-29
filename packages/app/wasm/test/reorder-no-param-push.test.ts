// The reported hiccup: toggling the delay/gate REORDER (the last transaction) makes the delay glide its
// offset. A reorder must touch NOTHING on existing plugins — no rebuild AND no parameter re-push (a re-push
// re-sets the delay time, and its `set_offset` glides). This drives the real engine + devices through the
// actual reorder while RENDERING, and asserts neither device_build_count nor param_push_count moves.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Update} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("reorder touches no existing plugin", () => {
    it("toggling the reorder rebuilds nothing and re-pushes no parameters", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
        const builds = () => engine.device_build_count() >>> 0
        const pushes = () => engine.param_push_count() >>> 0
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind()

        const REORDER = steps.length - 1 // the LAST transaction swaps the delay & gate index
        const applied: Array<ReadonlyArray<Update>> = []
        for (let at = 0; at < REORDER; at++) {applied[at] = stepForward(source, steps[at]); await sync.settle()}

        // Play + render to a steady state (so the delay has `processed === true`; only THEN would set_offset glide).
        engine.play()
        for (let q = 0; q < 64; q++) {engine.render()}
        const buildsBefore = builds()
        const pushesBefore = pushes()

        // Toggle the reorder back and forth, rendering between each (mirrors the user scrubbing last <-> prev).
        for (let round = 0; round < 8; round++) {
            applied[REORDER] = stepForward(source, steps[REORDER]); await sync.settle()
            for (let q = 0; q < 16; q++) {engine.render()}
            stepBackward(source, applied[REORDER]); await sync.settle()
            for (let q = 0; q < 16; q++) {engine.render()}
        }
        console.log(`builds ${buildsBefore} -> ${builds()}, param pushes ${pushesBefore} -> ${pushes()}`)
        expect(builds()).toBe(buildsBefore) // no plugin rebuilt by the reorder
        expect(pushes()).toBe(pushesBefore) // NO parameter re-pushed to any existing plugin
    })
})
