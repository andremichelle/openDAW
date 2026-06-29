// End-to-end AUDIO smoke test: build the whole project on the real engine + device modules, press play, and
// assert the master output is actually AUDIBLE. Every other engine test asserts box-graph checksums or
// processor identity — none asserts that sound comes out. This catches "the whole engine went silent"
// regressions (a broken master wiring, a summing bug, a stuck/zeroed bus) that checksums cannot see.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serializeUpdateTasks} from "../src/sync/serialize-update-tasks"
import {decodeSteps, readCommits, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")
const tick = () => new Promise(resolve => setTimeout(resolve))

describe("render smoke", () => {
    it("the fully-built project produces audible output", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory} = await loadFullEngine()
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
        const a = new BroadcastChannel("smoke"); const b = new BroadcastChannel("smoke")
        Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
        const sync = new SyncSource(source, Messenger.for(a), true)
        await tick(); engine.bind()
        for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await tick()}

        engine.play()
        let peak = 0
        let energy = 0
        let samples = 0
        for (let q = 0; q < 1200; q++) { // ~3.2s of audio at 48k
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len())
            for (let i = 0; i < out.length; i++) {
                const value = out[i]
                const magnitude = Math.abs(value)
                if (magnitude > peak) {peak = magnitude}
                energy += value * value
                samples++
                expect(Number.isFinite(value)).toBe(true) // no NaN / Inf escaping the graph
            }
        }
        const rms = Math.sqrt(energy / samples)
        console.log(`peak=${peak.toFixed(4)} rms=${rms.toFixed(4)}`)
        expect(peak).toBeGreaterThan(0.01) // the project is clearly audible, not silent
        expect(rms).toBeGreaterThan(0.0001) // and sustained, not a single click
    }, 30000)
})
