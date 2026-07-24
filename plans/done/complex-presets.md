# Complex Presets: Peer-owned state and Timeline content

## Motivation

openDAW presets today capture "just the device box": the `.toArrayBuffer()` of the effect or audio unit being saved. Anything that lives as a **peer box in the graph** — script parameter boxes, sample declaration boxes, automation regions, note regions, audio regions — is lost on save or never makes it out of the source project.

Four observable consequences:

1. **Werkstatt knobs disappear** after applying a Werkstatt effect preset. The script compiles fine and produces sound, but the editor renders zero knobs because the `WerkstattParameterBox` peers aren't serialized.
2. **Instrument / rack presets load silent** even when the source was animated by automation curves.
3. **Instrument / rack presets load empty** even when the source had a note pattern defining the sound's character.
4. **Audio clips on the source tracks don't come along** when a user saves a layered rack with backing samples.

The common thread: the graph is a network of peer boxes connected by pointers, and the current preset encoders only capture what's directly in the saved box's own payload. Peer state that lives in other boxes gets dropped on the floor.

This plan addresses all of the above in one coherent pass. Each phase ships independently, but they share the same design axis (what to include in the dep walk, how to remap pointers on decode, how to handle preserved-resource references).

---

## Current state

### What a preset captures today

| Category | Path | Encoded via | Contains |
|---|---|---|---|
| `audio-unit` (rack) | `PresetEncoder.encode` (`OPRE`) | full `ProjectSkeleton` + `dependenciesOf(audioUnitBox, alwaysFollowMandatory: true, stopAtResources: true)` | AudioUnit box, instrument box, all MIDI + audio effects, and the param/sample peers reached by the dep walk |
| `instrument` | same encoder, single AudioUnit root | same | same as rack |
| `audio-effect` / `midi-effect` / `*-chain` | `PresetEncoder.encodeEffectChain` (`OPEC`) | per-effect `toArrayBuffer` | **only the effect box itself** — no peers |

### What is excluded

The rack/instrument walk uses `TransferUtils.excludeTimelinePredicate`, which returns `true` for any `TrackBox`, so dependency walking stops at the track boundary. That bypasses:

- **`TrackBox`** (name, index, color, tracks collection pointer)
- **`ValueRegionBox`** / **`ValueClipBox`** — automation regions and clips
- **`ValueEventBox`** / **`ValueEventCollectionBox`** / **`ValueEventCurveBox`** — automation points and curves
- **`NoteRegionBox`** / **`NoteClipBox`** — note regions and clips
- **`NoteEventBox`** / **`NoteEventCollectionBox`** / **`NoteEventRepeatBox`** — notes
- **`AudioRegionBox`** / **`AudioClipBox`** — audio regions and clips (plus their references to preserved `AudioFileBox` resources)

The effect-chain encoder doesn't walk at all — it just serializes the single effect box. That's why Werkstatt loses its param knobs: `WerkstattParameterBox` instances are peers, not fields inside the Werkstatt box.

---

## Phase 1: Peer boxes in effect-chain presets

### Goal

A saved effect-chain preset must round-trip **all peer boxes whose `owner` points into the effect** — parameter boxes, sample boxes, any future per-effect peer data.

Specifically: saving and reloading a Werkstatt audio-effect preset must restore the knobs with the same labels and values the user saved. Same for samples.

### Design

Extend `PresetEncoder.encodeEffectChain` to include a dependency tail after the existing per-effect entries, preserving backward compatibility with effect presets that have no peers (Delay, Reverb, etc.).

**Dep walk scoping.** Effects point out to the host `AudioUnitBox` via their mandatory `host` pointer. Unscoped, `dependenciesOf(effect, {alwaysFollowMandatory: true})` climbs into the AudioUnit, then into `RootBox`, then everything. The walk must be explicitly bounded:

```ts
const excludeBox = (box: Box): boolean =>
    TransferUtils.shouldExclude(box)
    || TransferUtils.excludeTimelinePredicate(box)
    || box instanceof AudioUnitBox
```

Excluding `AudioUnitBox` severs the climb-through-host path. The host pointer becomes dangling in the preset file; the decoder rewrites it to the new target's effect-field address (same pattern already present for the host-pointer remap in `PresetDecoder.insertEffectChain`).

**Wire format (backward compatible).** Append an optional tail after the existing v1 per-effect entries:

```
magic (int32)
version (int32) = 1      -- unchanged
kind (int32)
count (int32)
[ className, payloadLen, payload ] × count   -- unchanged, v1-compatible
--- optional tail ---
effectSourceUuids: 16 bytes × count           -- source UUIDs of the effects, for dep pointer remap
depsCount (int32)
[ className, sourceUuid (16 bytes), payloadLen, payload ] × depsCount
```

Old decoders stop after the count-prefixed entries and ignore any trailing bytes. Delay/Reverb presets saved pre-fix continue to load without change. New decoders detect the tail via `input.remaining() > 0`, build a single `source → target` UUID map covering effects and deps, and create both in one `PointerField.decodeWith` block that:

- Rewrites the effect's `host` pointer to the target's `audioEffects` / `midiEffects` field address (as today).
- Rewrites peer `owner` pointers (e.g. `WerkstattParameterBox.owner`) via the UUID map so they target the newly-created Werkstatt's `parameters` field.

### Format versioning

Keep `FORMAT_VERSION_OPEC = 1`. The format remains binary-compatible — the tail is a pure extension that old readers skip.

---

## Phase 2: Timeline content in rack/instrument presets

### Goal

A rack or instrument preset saved with timeline content replays the same tracks, note patterns, automation curves, and audio clips on load — same shapes, same timing (normalized to preset-local position 0), same targets.

Three kinds of timeline content are covered:

- **Automation**: `ValueRegionBox` / `ValueClipBox` / `ValueEventCollectionBox` / `ValueEventBox` / `ValueEventCurveBox`
- **Notes**: `NoteRegionBox` / `NoteClipBox` / `NoteEventCollectionBox` / `NoteEventBox` / `NoteEventRepeatBox`
- **Audio**: `AudioRegionBox` / `AudioClipBox` (both pointing at preserved `AudioFileBox` resources)

All three live on `TrackBox` instances which belong to the AudioUnit. The save path is shared — widen the dep walk past `TrackBox`. The load path is mostly shared too, with one extra concern for audio: the `AudioFileBox` may not exist in the target project.

### Design

**Encoder opt-in.**

```ts
// PresetEncoder.encode
PresetEncoder.encode(audioUnitBox, {includeTimeline?: boolean})
```

When `includeTimeline: true`, the `excludeBox` predicate drops `TransferUtils.excludeTimelinePredicate` so the walk follows `AudioUnitBox.tracks` → `TrackBox` → each region/clip kind → event collections → events / curves. `AudioFileBox` and `SoundfontFileBox` continue to halt the walk via the existing `stopAtResources: true` flag — their UUIDs get preserved but their payload is not embedded.

**`TransferUtils` helper.**

Split the timeline exclusion so consumers can opt in cleanly:

```ts
TransferUtils.excludeTimelinePredicate      // existing: excludes TrackBox (default behavior)
TransferUtils.includeTimeline                // new: allow TrackBox + all region/event descendants
```

A single include-predicate covers all three kinds because the `TrackBox` root is the same. Granular per-kind inclusion isn't worth the API surface — a user who wants notes usually wants automation too.

**Decoder: re-parenting.**

`PresetDecoder.decode` currently creates a default empty `TrackBox` for each imported AudioUnit at lines 79-100. With timeline inclusion, the preset already carries `TrackBox`es — skip the default-track creation if any track pointing at the new AudioUnit was copied.

**Region position normalization.**

Regions carry absolute `ppqn` positions from the source project. On load the user expects them at position 0. Use the delta-shift pattern already present in `TransferUtils.extractRegions` (lines 166-168). Extract it into a reusable helper:

```ts
TransferUtils.normalizeRegionsToZero(regions: ReadonlyArray<AnyRegionBox>): void
```

Call from `PresetDecoder.decode` after timeline copy, across all region kinds (value / note / audio).

**Cross-boundary automation targets.**

If a `ValueEventBox` targets a parameter outside the saved AudioUnit (a send-on-another-track, a master param), the target is unresolvable in the preset dependency graph. Drop the containing `ValueRegionBox` at encode time with a warning rather than emitting a dangling pointer.

**Missing audio files on load.**

`AudioRegionBox` / `AudioClipBox` keep their `AudioFileBox` UUID on save (resources are preserved, not copied — same pattern as sample-library references today). On load, the decoder checks whether the referenced `AudioFileBox` exists in the target graph:

1. If present → the region resolves normally.
2. If absent → drop the region with a single aggregated warning (`"N audio regions reference samples not in your library. They were omitted."`). Dropped regions don't prevent the rest of the preset from loading.

A future extension could hook the cloud sample fetch into this path so missing samples auto-download. Not required for v1.

### Format versioning

Bump `FORMAT_VERSION_OPRE = 2` (rack/instrument format only; `FORMAT_VERSION_OPEC` stays at 1). Split the shared constant:

```ts
export const FORMAT_VERSION_OPRE = 2
export const FORMAT_VERSION_OPEC = 1
```

Decoder dispatches on magic to pick the version constant. v1 OPRE files still load — they simply don't carry timeline boxes, default track creation fires as today.

### Implementation order within Phase 2

The three kinds share plumbing but have different risk profiles. Ship in this order so regressions are contained:

1. **Automation** first — no resources involved, lowest risk. Exercises the `includeTimeline` flag, the re-parenting guard, and `normalizeRegionsToZero`.
2. **Notes** — same plumbing, adds no new decoder branches.
3. **Audio** — last, because it introduces the missing-file handling. Build on the already-tested timeline scaffolding.

---

## Save-dialog UI

`PresetDialogs.showSavePresetDialog` returns `{name, description}`. Extend to return `{name, description, includeTimeline}`:

- Checkbox **"Include timeline (automation, notes, and audio clips)"**. Default **off** for discoverability and backward-compatibility behavior.
- Hidden entirely for effect-chain saves (Phase 1 needs no UI — peer boxes are always included, no user choice).

Call sites to thread the new field through:

- `LibraryActions.saveAsInstrumentPreset`
- `LibraryActions.saveAsRackPreset`
- `LibraryActions.saveAsChainPreset` *(effect-chain flow — ignores the field)*
- `LibraryActions.saveAsSingleEffectPreset` *(effect-chain flow — ignores the field)*
- `LibraryActions.handleRackDrop`
- `LibraryActions.replacePreset`

---

## Metadata tagging (optional, low priority)

`PresetMeta` gains one optional flag:

```ts
hasTimeline?: boolean    // Phase 2: preset carries automation, notes, and/or audio clips
```

(`hasPeers` was considered but dropped — Phase 1 includes peer boxes unconditionally in every effect preset, so the flag has no discriminative value.)

`LibraryBrowser` renders a small badge on preset rows with `hasTimeline: true` so users can spot timeline-bearing presets at a glance. Purely cosmetic; skip for v1 if it adds noise.

---

## Non-goals

- **Cross-track automation.** Resolved by the existing `stopAtResources` + resource-type schema: `ValueEventCollectionBox` and `NoteEventCollectionBox` are tagged `"shared"`, so the dep walk does not climb through them into other owners. No extra handling needed at encode time.
- **Region position normalization.** Out of scope — we respect the user's saved `ppqn` positions and do not rewrite them on decode. Saved-with-timeline presets reconstruct regions at the positions they were saved at.
- **Preset-side graceful degradation for missing samples.** Out of scope. Policy: samples referenced by a preset must be on the local machine. Sample deletion is a global scan (see the new requirement below) — presets get scanned alongside projects so a sample can't be deleted while a preset still references it.
- **Capture boxes.** `CaptureMidiBox` / `CaptureAudioBox` stay excluded (input routing, not content).
- **Effect-chain timeline content.** Automation on a single effect's parameter would require saving a detached `ValueEventCollectionBox` + re-wiring to a per-target track on load. Separate problem; not addressed here.
- **Tempo / time signature.** Project-level, not preset-level.

---

## New requirement: sample-deletion scans presets

Samples referenced by a preset must stay on the local machine. The project-deletion scanner that prevents deleting a sample in use by a project must be extended to scan the user preset index as well:

- On `SampleStorage.deleteItem(uuid)`: walk every entry in `PresetStorage.readIndex()`, load the `.odp`, inspect its graph for `AudioFileBox` references matching the sample's UUID.
- If any preset references the sample, refuse the delete (or prompt the user with the list of referring preset names).
- Symmetrical with the existing projects-scan path — add `PresetStorage` as a second data source to whatever existing scanner drives the projects check.

Stock presets do not need the scan (they live remote and reference samples the user already opted into when downloading the preset).

---

## Implementation order

1. **Phase 1 decoder tolerance.** Update `PresetDecoder.insertEffectChain` to accept an optional peer-box tail (`input.remaining() > 0`). If absent (old file, simple effect), behave exactly as today. Harmless when no tail.
2. **Phase 1 encoder.** `PresetEncoder.encodeEffectChain` writes the peer-box tail with the `AudioUnitBox`-excluded dep walk. **This ships Phase 1, fixes Werkstatt knobs.**
3. **`FORMAT_VERSION_OPRE` split.** Rename `FORMAT_VERSION` constants so OPRE and OPEC evolve independently.
4. **`TransferUtils.normalizeRegionsToZero` helper.** Extract delta-shift logic from `extractRegions`.
5. **`TransferUtils.includeTimeline` predicate.** Add the opt-in predicate that allows `TrackBox` + all region/event descendants.
6. **Phase 2a: automation.** Timeline-inclusive walk with automation boxes, default-track guard in `PresetDecoder.decode`, position normalization. Bumps OPRE to v2. **Ships automation.**
7. **Phase 2b: notes.** Reuses the Phase 2a encoder path — notes arrive for free once `includeTimeline` is in place. **Ships notes.**
8. **Phase 2c: audio clips.** Same encoder path; decoder gains the missing-`AudioFileBox` handling. **Ships audio clips.**
9. **Save dialog.** Add "Include timeline" checkbox, thread through call sites.
10. **Optional metadata tagging + browser badge.**

Phase 1 is the immediate bug-fix priority — ships on its own without any of Phase 2-3 plumbing.

---

## Open questions

- **Multi-track AudioUnits.** A future AudioUnit might have more than one `TrackBox` (separate MIDI + audio tracks on one unit). The encoder should walk `AudioUnitBox.tracks` as a collection; the decoder's default-track creation already needs to become a "create only the track types that were absent in the preset" pass.
- **Audio region trimming past `AudioFileBox` duration.** If the decoder later auto-fetches the missing sample and the fetched file is a different length, the region's `loopDuration` / `trim` fields may reference ranges that don't exist. Decide at fetch time: clamp or warn?
- **Peer box identity across chains.** If a dep peer is shared between two effects in the same chain save (theoretically possible if ever introduced), the current design copies it once (the dep walk dedupes by box identity). Pointer remap handles both effects referencing the same new peer UUID.
- **Tone3000 (`NeuralAmpDeviceBox`).** This device loads its state from an external service (see `NamTone3000.ts`, `Tone3000Dialog.tsx`) rather than from pointer-reachable peer boxes. Its serialized box fields may not fully describe the sound without the fetched neural model. **Decision:** treat it as a special device in the library / device header — render its icon in the coloured variant without the button frame so it reads visually distinct from regular stock devices. Preset-save semantics unchanged (the model identifier is a regular box field, so the model id is already persisted; the user re-fetches on load if the cache is cold). The visual treatment signals "this one is special, mind the network dependency".

---

## Future enhancements

- **Per-device preset pager.** When a device is selected/edited, expose prev/next controls (arrows or a dropdown) that cycle through the device's matching presets in the library — rapid A/B auditioning without opening the library panel. Scoped to the device's `category` + `device`/`instrument` key; source-agnostic (user + cloud). UI lives on the device header. Load via the existing `activatePreset` path so all replace semantics (timeline handling, effect-chain extraction) still apply.
