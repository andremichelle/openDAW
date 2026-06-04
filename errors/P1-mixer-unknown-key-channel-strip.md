# Mixer Unknown-key channel-strip

- **status:** OPEN · **priority:** P1
- **occurrences:** 5 · **ids:** [924, 925, 926, 984, 985]
- **assessment:** SortedSet.get() (sorted-set.ts:128) misses inside Mixer.registerChannelStrip (Mixer.ts:64). 5x, recent.
- **action:** Find the by-uuid map queried before insert/after remove; getOrNull + guard. Reproduce add/remove audio-unit while mixer open.

[< back to index](error-triage.md)

## Reports

### Error: Unknown key: N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N
- **occurrences:** 5 · **ids:** [924, 925, 926, 984, 985] · **span:** 2026-04-20->2026-05-26 · **builds:** 2 · **browsers:** Chrome/Win, Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at g (../../../lib/std/dist/lang.js:10:103 (panic))`
  - `at bA.get (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:2:33246)`
  - `at Jq.registerChannelStrip (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:90:23407)`
  - `at CL (...)  ← ChannelStrip factory`
  - `at Kt (lib/jsx create-element)  ← rendered during UI Mixer catchup forEach`

## Investigation log — Mixer/UI desync (2026-06-04)

**Status: root mechanism identified, exact trigger unproven — no fix shipped (no band-aids).**

`Mixer.registerChannelStrip` (`packages/studio/core/src/Mixer.ts:64-65`) does `this.#states.get(uuid)`, which **panics** ("Unknown key") when that audio-unit uuid is absent from the core Mixer's `#states`. So a `ChannelStrip` view is being created for a unit the core Mixer never registered.

**Confirmed:**
- Core `Mixer` (`Project.ts:221`, `new Mixer(rootBoxAdapter.audioUnits)`) and the UI `Mixer.tsx` (`audioUnits.catchupAndSubscribe`, line 97) subscribe to the **same stable** collection (`RootBoxAdapter.#audioUnits`). `ChannelStrip` reads `mixer` from the same `project`. So it is not two different collections/projects.
- The crash is during the **UI Mixer's catchup forEach** (`IndexedBoxAdapterCollection.catchupAndSubscribe`, line 76) — i.e. rendering a strip for an existing entry.
- Ordering: `IndexedBoxAdapterCollection.onAdded` adds the adapter to `#entries` (line 55) **before** notifying listeners' `onAdd` (line 57). So if the core Mixer's `onAdd` throws for a unit, that unit stays in `#entries` (UI sees it) but never enters `#states`.
- Core Mixer `onAdd` (Mixer.ts:31-54) reads `adapter.namedParameter.{mute,solo}` and calls `.catchupAndSubscribe` on them. A migrated/malformed `AudioUnitBox` missing those named parameters would make `onAdd` throw.

**Strong hypothesis:** on a **migrated** project (#985 logs show `migrate project from …`), one audio unit makes the core Mixer's `onAdd` throw (e.g. missing mute/solo named parameter). The throw leaves the unit in the collection but not in `#states`; the swallowed error means load continues, and the UI later renders that unit's `ChannelStrip` → `registerChannelStrip` panics. All 5 reports are from only 2 builds (Chrome/Edge on Windows), consistent with a specific migrated project.

**Why no fix shipped:** can't confirm the offending unit/parameter without the project file, and the candidate fixes are all risky guesses (swallow in `onAdd`; roll back `#entries` on listener error; lazy-create `#states` in `registerChannelStrip` — the last is a band-aid that hides the desync).

**Recommended next step (debugging-first):** add low-noise instrumentation — in `registerChannelStrip`'s miss path, throw a richer error capturing `adapter.box.isAttached()`, whether `adapter.namedParameter` has mute/solo, and `#states.size`; and/or wrap the core Mixer `onAdd` mute/solo subscription so a malformed unit **logs** (with uuid) instead of silently throwing. Either confirms the trigger in the next production report. Then fix the migration/parameter gap at its source.