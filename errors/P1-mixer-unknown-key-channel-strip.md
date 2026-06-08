# Mixer Unknown-key channel-strip

- **status:** OPEN (rich diagnostic shipped; root cause unconfirmed) · **priority:** P1
- **occurrences:** 5 · **ids:** [924, 925, 926, 984, 985]
- **assessment:** `SortedSet.get` miss inside `Mixer.registerChannelStrip` → bare `Unknown key: <bytes>`. A ChannelStrip was requested for an audio-unit absent from core Mixer's `#states`.
- **action (done):** Replaced the bare `get` with a rich panic capturing uuid/type/attached/#states.size so the next occurrence is locatable. Root cause still unconfirmed (see below) — do NOT mark fixed yet.

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

## Update (2026-06) — deeper trace; the earlier onAdd-throw theory is contradicted

**Swallow mechanism CONFIRMED:** `Listeners.proxy` (`lib/std/listeners.ts`) dispatches **object-literal** listeners via `safeExecute` (swallows exceptions); core `Mixer` subscribes with an object literal, so a throw in its live `onAdd` is silently swallowed. But `IndexedBoxAdapterCollection.catchupAndSubscribe` calls `onAdd` **directly** (not via the proxy), so catchup throws propagate. So a desync created on a live add stays hidden until the panel opens.

**BUT the onAdd-throw theory is contradicted:** `#updateChannelStripViews`/`#processChannelStrips` call `getControlledValue()` on every `#states` entry and run via `deferUpdate` on any add/mute/solo change (independent of the mixer panel). If a unit's mute/solo `getControlledValue()` threw, those would crash routinely — but the logs only ever show "Unknown key", never that. So `getControlledValue` does not throw, `onAdd` completes `#states.add`, and `#states` should contain the unit. The desync is NOT core `onAdd` throwing.

**More likely lead — a second render site:** ChannelStrip is rendered from TWO places: the mixer panel (`Mixer.tsx:100`, from `rootBox.audioUnits` catchup) AND `DevicePanel.tsx:136` (`adapter={deviceHost.audioUnitBoxAdapter()}`). DevicePanel resolves the host unit by walking device→host, **independently of the `audioUnits` collection / `#states`**. If a device's host unit is not in `rootBox.audioUnits` (migration leftover, or a unit being detached while its device panel is open), DevicePanel's strip → `registerChannelStrip` → `#states` miss. The doc's earlier "rendered during UI Mixer catchup forEach" was a guess from minified frames; DevicePanel render is also `createElement → ChannelStrip`.

**Shipped:** `registerChannelStrip` now panics with `Mixer has no channel-strip state for audio-unit <uuid> (type=…, attached=…, states=…)` instead of bare "Unknown key". Still panics (not softened to a silent skip — that would hide the desync, per no-band-aids). The next report will name the unit, its type, and whether it is attached → confirming which site/scenario, then fix at source (likely DevicePanel guarding on a non-collection unit, or the migration that leaves a device host outside `rootBox.audioUnits`).