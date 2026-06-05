# Box-graph requires-an-edge

- **status:** #983 FIXED (commit 2a4a2566d) · #820 likely already fixed (not reproducible in current code) · **priority:** P2
- **occurrences:** 2 · **ids:** [820, 983]
- **assessment:** Two unrelated causes. #983: paste of a unit with an aux-send automation lane (FIXED). #820: a March-17 record-audio bug whose onSaved swap has since been reworked — not reproducible now.
- **action:** #983 set fixed=1. #820 verify on a current build, then set fixed=1.

[< back to index](error-triage.md)

## Reports

### Error: Pointer {Wt:Ce (target) UUID/N requires an edge.
- **occurrences:** 1 · **ids:** [983] · **span:** 2026-05-25->2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at tj.tryValidateAffected (../../../lib/box/dist/graph-edges.js:101:43)`
  - `at na.endTransaction (../../../lib/box/dist/graph.js:60:24)`
  - `at ../../../lib/box/dist/editing.js:172:24`
  - `at at (VideoOverlay.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:1:1493)`

### Error: Target Wt UUID requires an edge.
- **occurrences:** 1 · **ids:** [820] · **span:** 2026-03-17->2026-03-17 · **builds:** 1 · **browsers:** Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at main.879b1d06-6455-4576-a16d-09c07818d1fa.js:4:93645`
  - `at Array.forEach (<anonymous>)`
  - `at g_.forEach (main.879b1d06-6455-4576-a16d-09c07818d1fa.js:2:32983)`

## Investigation (root cause + recommended fix)

**820 — STATUS: likely already fixed (not reproducible in current code).** #820 is from the 2026-03-17 build. `git log` shows `RecordAudio.onSaved`'s file-box swap was reworked **after** the report — the transient-marker handling was added in `085d0de5c "may fix 871"` (2026-03-25), with several further recording fixes since. I could not reproduce the `Target … requires an edge` panic in current code:
- Verified mechanism (confirmed in code): `oldFileBox.pointerHub.incoming()` does aggregate the `transient-markers` field's pointers (`incomingEdgesOf` collects all same-box edges, `pointer-hub.ts:67` / `graph-edges.ts:93-96`), and `AudioFileBox` is a box-level mandatory target (`AudioFileBox.ts:51-57`).
- BUT recordings never create transient markers on the recording file box before `onSaved` — transients are detected/created later on the *saved* sample (`AudioFileBoxFactory.ts:8`, `AudioContentModifier.ts:110`), not in the capture path. So `incomingPointers` only ever holds the region's `AudioFile` pointer; the region-deleted case (log: "consumed by Regions") leaves it empty and hits the early `delete()` guard cleanly. The only-transient scenario that would break the swap isn't reachable.
- A direct probe of the only-transient swap throws a *different* error (`"… does not satisfy any of the allowed types"` at `refer`), not #820's `requires an edge` — confirming the reported state doesn't arise here.

**Recommendation (820): verify on a current build** (record a take, delete its region, stop) and then **mark `fixed=1`** — it was a real bug in the March-17 code that has since been reworked. No code change shipped.

**Evidence (original, March-17 build):** log tail `importSample 'Recording'` -> `save sample 'samples/v2/2b580f94...'` -> `requires an edge`; the panicking UUID equals the *saved* sample UUID (the freshly-created `newFileBox`).

**983 — FIXED (commit `2a4a2566d`), root cause confirmed by reproduction.** The agent's earlier `ValueEventCollection.owners` hypothesis was wrong — the panicking field `/2` is **`TrackBox.target`** (`Pointers.Automation`), not a collection's `owners`. Verified mechanism: an automation (Value) lane targets an **aux-send level** (`AuxSendBox.sendGain`); `copyAudioUnit` excludes `AuxSendBox` (routing stays with the project), but the lane's mandatory `target` still reaches it, so on paste the target box isn't in the copied set and the mapper returns `None` for `Pointers.Automation` → `TrackBox.target` is left unwired → `endTransaction` panics. Reproduced with a RED→GREEN test in `AudioUnitsClipboardHandler.test.ts`.

**Fix:** `copyAudioUnit` now also drops a `TrackBox` whose `target` resolves to an excluded box (aux-send/bus/MIDI-controller/root), so the orphaned lane never enters the clipboard. Behaviour: paste succeeds; the orphan lane (and its region) is dropped; local lanes (targeting in-unit devices/the unit) are kept and rewired. Dependency collection extracted to an exported `collectDependencies` so the test exercises the real logic.
- Both are still single-occurrence with no local repro; if a fix cannot be landed with confidence, add low-noise diagnostics in `graph-edges.ts:122-123` capturing `new Error().stack` plus the offending box name/UUID and the addresses of its expected-but-missing incoming pointer types, gated only on the panic branch, so the next report names the exact op and field.
