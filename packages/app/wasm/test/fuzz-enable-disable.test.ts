// FUZZ: drive a long, SEEDED-random sequence of enable/disable toggles across every plugin and track through the
// real SyncSource, and assert three invariants after each step: the engine stays IN SYNC with the source (the
// checksum RPC in `settle()` rejects on any divergence), the rendered audio is finite (no NaN/Inf escaping the
// graph), and nothing panics. Then it UNDOES every flip and asserts the audio returns BIT-IDENTICAL to the start
// (path-independence: no random sequence leaves corrupting residue). The seed is fixed so a failure reproduces.

import {describe, expect, it} from "vitest"
import {DeviceBoxUtils} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {buildProject, maxDiff} from "./helpers/render-harness"

describe("fuzz: random enable/disable", () => {
    it("random toggles never desync or produce NaN/Inf, and undo to bit-identical audio", async () => {
        const {engine, memory, source, sync, capture} = await buildProject()
        // Every togglable boolean that this work touches: each device's `enabled` (instruments, effects, composites,
        // slots) and each track's `enabled`.
        const fields = [
            ...source.boxes().filter(DeviceBoxUtils.isDeviceBox).map(box => box.enabled),
            ...source.boxes().filter((box): box is TrackBox => box instanceof TrackBox).map(box => box.enabled)
        ]
        expect(fields.length).toBeGreaterThan(0)
        const initial = fields.map(field => field.getValue())
        const baseline = capture(64)

        // xorshift32, seeded, so a failing run is reproducible.
        let state = 0x9e3779b9 | 0
        const nextIndex = (): number => {
            state ^= state << 13
            state ^= state >>> 17
            state ^= state << 5
            state |= 0
            return (state >>> 0) % fields.length
        }
        for (let iteration = 0; iteration < 80; iteration++) {
            const field = fields[nextIndex()]
            source.beginTransaction()
            field.setValue(!field.getValue())
            source.endTransaction()
            await sync.settle() // REJECTS if the engine's checksum diverged from the source (a desync)
            let nonFinite = false
            for (let q = 0; q < 8; q++) {
                engine.render()
                const out = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len())
                for (let i = 0; i < out.length; i++) {
                    if (!Number.isFinite(out[i])) {nonFinite = true; break}
                }
            }
            expect(nonFinite).toBe(false) // no NaN / Inf escaping the graph at any point of the random walk
        }

        // Undo every flip: the box graph returns to its initial state, and so must the AUDIO.
        source.beginTransaction()
        fields.forEach((field, index) => field.setValue(initial[index]))
        source.endTransaction()
        await sync.settle()
        expect(maxDiff(baseline, capture(64))).toBe(0) // path-independence: 80 random toggles, undone, leave no residue
    }, 60000)
})
