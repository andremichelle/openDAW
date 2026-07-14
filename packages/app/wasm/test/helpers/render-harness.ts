// Builds the test project on the REAL engine + device modules, metronome OFF and samples loaded, so a test
// renders genuine instrument audio. `capture(n)` renders n quanta of the master output from a CLEAN transport
// (stop rewinds + resets every plugin), so two captures of the same graph are directly comparable. Shared by the
// differential and fuzz audio tests.

import * as path from "node:path"
import {readFileSync} from "node:fs"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepForward} from "../../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./load-full-engine"
import {connectSyncToEngine} from "./connect-sync"

const ODSL = path.resolve(__dirname, "../../public/odsl/test.odsl")

export const buildProject = async () => {
    const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
    const {engine, memory, drainSamples} = await loadFullEngine()
    const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
    const steps = decodeSteps(commits)
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind()
    engine.set_metronome_enabled(0)
    for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await sync.settle()}
    drainSamples()
    const capture = (quanta: number): Float32Array => {
        engine.stop(); engine.play()
        const len = engine.output_len() >>> 0
        const buffer = new Float32Array(quanta * len)
        for (let q = 0; q < quanta; q++) {
            engine.render()
            buffer.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        return buffer
    }
    return {engine, memory, source, sync, drainSamples, capture}
}

export const maxDiff = (a: Float32Array, b: Float32Array): number => {
    if (a.length !== b.length) {throw new Error(`length mismatch ${a.length} != ${b.length}`)}
    let max = 0
    for (let i = 0; i < a.length; i++) {
        const diff = Math.abs(a[i] - b[i])
        if (diff > max) {max = diff}
    }
    return max
}
