// Measures whether a full sync-log forward+rewind cycle leaks engine heap: after a warm-up cycle (one-time
// high-water growth — pools, Vec capacities, talc claims — is the accepted category), every later return to
// step 0 must land on the SAME heap_used. Linear growth across cycles = a real per-cycle leak.
import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepBackward, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const CYCLES = 20

describe("heap across sync-log cycles", () => {
    it("forward+rewind returns to the same heap_used after warm-up", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory, drainSamples} = await loadFullEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        drainSamples()
        const atStart: Array<number> = []
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            const applied = []
            for (let at = 0; at < steps.length; at++) {
                applied[at] = stepForward(source, steps[at])
                await sync.settle()
            }
            drainSamples()
            for (let at = steps.length; at > 0; at--) {
                stepBackward(source, applied[at - 1])
                await sync.settle()
            }
            atStart.push(engine.heap_used() >>> 0)
            if (isDefined(engine.debug_probe)) {
                const probePtr = engine.input_reserve(56)
                engine.debug_probe(probePtr)
                const counts = Array.from(new Uint32Array(memory.buffer, probePtr, 14))
                const [processors, labels, queueLen, queueCap, nextNodeId, contextRegistry, vertices, boxes, subscriptions, broadcasts, units, outputRegistry, slotsEver, slotsLive] = counts
                console.log(`cycle ${cycle}: heap=${(atStart[cycle] / 1024).toFixed(1)} processors=${processors} labels=${labels} queue=${queueLen}/${queueCap} nextNodeId=${nextNodeId} ctxRegistry=${contextRegistry} vertices=${vertices} boxes=${boxes} subs=${subscriptions} broadcasts=${broadcasts} units=${units} outRegistry=${outputRegistry} sampleSlots=${slotsLive}/${slotsEver}`)
            }
        }
        console.log("heap_used at step 0 per cycle:", atStart.map(bytes => (bytes / 1024).toFixed(1)).join(" -> "), "KB")
        const settled = atStart.slice(1)
        const growth = settled[settled.length - 1] - settled[0]
        console.log(`growth after warm-up: ${growth} bytes over ${settled.length - 1} cycle(s)`)
        expect(growth, "post-warm-up cycles must not grow the heap").toBe(0)
    }, 120000)
})
