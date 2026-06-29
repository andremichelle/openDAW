// End-to-end AUDIO smoke test: build the whole project on the real engine + device modules, press play, and
// assert the master output is actually AUDIBLE. Every other engine test asserts box-graph checksums or
// processor identity — none asserts that sound comes out. This catches "the whole engine went silent"
// regressions (a broken master wiring, a summing bug, a stuck/zeroed bus) that checksums cannot see.

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("render smoke", () => {
    it("the fully-built project produces audible output", async () => {
        const commits = readCommits(readFileSync(ODSL).buffer as ArrayBuffer)
        const {engine, memory, drainSamples} = await loadFullEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind()
        // Turn the metronome OFF and feed the samplers real samples, so this asserts genuine INSTRUMENT audio (the
        // synths + the Playfield slots) — not the 0.5 metronome click, which would mask a silent instrument graph.
        engine.set_metronome_enabled(0)
        for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await sync.settle()}
        expect(drainSamples()).toBeGreaterThan(0) // the project has sample-based slots; they are now audible

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
        expect(peak).toBeGreaterThan(0.1) // real instruments are clearly audible (no metronome to lean on)
        expect(rms).toBeGreaterThan(0.005) // and sustained, not a single click
    }, 30000)
})
