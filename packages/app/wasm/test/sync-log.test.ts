// Headless test of the Sync Log navigation (read side): load test.odsl, fast-forward to the end, then
// fully rewind to the start, applying each transaction through the SAME stepper the page uses.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Update} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {COMMIT_INIT, decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("sync-log navigation", () => {
    it("fast-forwards to the end and fully rewinds to the start", () => {
        const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
        expect(commits.length).toBeGreaterThan(1)
        expect(commits[0].type).toBe(COMMIT_INIT)
        const {boxGraph} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const initialChecksum = boxGraph.checksum()
        const initialBoxes = boxGraph.boxes().length

        // FF: apply every transaction forward, capturing the complete applied-update list per step.
        const applied: Array<ReadonlyArray<Update>> = steps.map(updates => stepForward(boxGraph, updates))
        const endBoxes = boxGraph.boxes().length
        expect(endBoxes).not.toBe(initialBoxes) // the log actually built something

        // FR: invert every step, from last to first.
        for (let at = steps.length; at > 0; at--) {
            stepBackward(boxGraph, applied[at - 1])
        }

        // Back at the Init state: same box count AND same checksum as where we started.
        expect(boxGraph.boxes().length).toBe(initialBoxes)
        expect(boxGraph.checksum()).toEqual(initialChecksum)
        console.log(`init=${initialBoxes} end=${endBoxes} rewound=${boxGraph.boxes().length} over ${steps.length} transactions; checksum restored`)
    })
})
