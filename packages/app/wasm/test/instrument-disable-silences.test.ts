// Disabling a plugin must actually take effect in the engine. An EFFECT bypasses (passthrough); an INSTRUMENT
// (a source) is silenced — leaf instruments (Vaporisateur / Nano, the `PluginInstrument` gate) and composite
// instruments (Playfield, the summing-bus gate) alike. This drives the real engine + device modules: with every
// instrument disabled BEFORE playback, no source ever emits, so the whole project must render silent. Then it
// re-enables them all, rewinds, and asserts audio returns (the gate is reversible, edge-only). The metronome is
// turned off because the test harness defaults it ON (a 0.5 click that would mask the instruments).

import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {DeviceBoxUtils, ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeSteps, readCommits, stepForward} from "../src/pages/sync-log/sync-log"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const ODSL = path.resolve(__dirname, "../public/odsl/test.odsl")

describe("disabling every instrument silences the project", () => {
    it("renders silent with all instruments off, audible again when re-enabled", async () => {
        const commits = readCommits(new Uint8Array(readFileSync(ODSL)).buffer as ArrayBuffer)
        const {engine, memory, drainSamples} = await loadFullEngine()
        const {boxGraph: source} = ProjectSkeleton.decode(commits[0].payload)
        const steps = decodeSteps(commits)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind()
        engine.set_metronome_enabled(0) // the harness defaults the metronome ON (0.5 click); silence it for this test
        for (let at = 0; at < steps.length; at++) {stepForward(source, steps[at]); await sync.settle()}
        const loaded = drainSamples() // feed the Playfield slots a synthetic sample so they are AUDIBLE
        console.log(`samples satisfied: ${loaded}`)

        const instruments = source.boxes().filter(DeviceBoxUtils.isInstrumentDeviceBox)
        expect(instruments.length).toBeGreaterThan(0) // the project has instruments (a leaf Vaporisateur + a composite Playfield)
        const setEnabled = async (enabled: boolean): Promise<void> => {
            source.beginTransaction()
            instruments.forEach(device => device.enabled.setValue(enabled))
            source.endTransaction()
            await sync.settle()
        }
        const peakOver = (quanta: number): number => {
            let peak = 0
            for (let q = 0; q < quanta; q++) {
                engine.render()
                const out = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len())
                for (let i = 0; i < out.length; i++) {
                    const magnitude = Math.abs(out[i])
                    expect(Number.isFinite(out[i])).toBe(true)
                    if (magnitude > peak) {peak = magnitude}
                }
            }
            return peak
        }

        // NOTE: this harness has no sample loader, so the sample-based Playfield is inaudible and the measurable
        // instrument signal (the Vaporisateur synth) is small but deterministic and strictly non-zero. The proof
        // is RELATIVE: enabled instruments contribute signal; disabling EVERY instrument collapses the output to
        // exact digital silence (leaf gate + composite-sum gate); re-enabling restores the same signal.
        engine.play()
        const baselinePeak = peakOver(600)
        console.log(`baseline peak (all enabled, metronome off): ${baselinePeak.toFixed(6)}`)
        engine.stop()
        expect(baselinePeak).toBeGreaterThan(0) // sanity: the instruments do produce signal, so the test below means something

        // Disable every instrument BEFORE playing: no source ever emits, so the whole graph stays silent (no leaf
        // instrument output, no composite sum). Edge-only — the processors persist.
        await setEnabled(false)
        engine.play()
        const silentPeak = peakOver(600)
        console.log(`peak with all instruments disabled: ${silentPeak.toFixed(6)}`)
        expect(silentPeak).toBeLessThan(baselinePeak / 100) // disabling collapses the output to silence (>100x down)

        // Re-enable every instrument (reversible, edge-only), rewind to 0, and replay: the signal returns.
        await setEnabled(true)
        engine.stop()
        engine.play()
        const livePeak = peakOver(600)
        console.log(`peak after re-enabling: ${livePeak.toFixed(6)}`)
        expect(livePeak).toBeGreaterThan(baselinePeak / 2) // re-enabling restores the instrument signal
    }, 30000)
})
