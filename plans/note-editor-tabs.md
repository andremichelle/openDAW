# Note Editor Tabs and Note Feature Boxes

## Goal

The note editor header gets four tabs (Basic, Random, Scale, Split). `NoteEventBox` keeps only what every note has. Everything else is an aux box that points to the note through the existing `Pointers.NoteEventFeature`. A note without aux boxes plays exactly like a plain note today.

Chance gets groups: all members of a group play together or not at all (chords). Split (today "play count" and "play curve") gets room for more features, starting with velocity fades.

## Current state

1. `NoteEventBox` holds position, duration, pitch, velocity, cent (24), play-count (22), play-curve (23), chance (25). It already accepts `Pointers.NoteEventFeature`.
2. `NoteEventRepeatBox` exists in the schema (event, count, curve, length) with a TODO, but nothing creates it.
3. The header (`PitchEditorHeader.tsx`) stacks the scale row (`ScaleSelector`, `ScaleConfigurator`, scale menu, follow key) above `PropertyTable.tsx`, which shows all eight note fields in one grid.
4. The engine (Rust) reads the note fields in `crates/bindings/src/note_events.rs` and plays chance and ratchets in `crates/engine-env/src/note_sequencer.rs` (`process_collection`, `play_grooved`). `ValueCollection` already follows an aux box (`ValueEventCurveBox`), that is the template for notes.
5. Users of the three fields: `NoteEventBoxAdapter` (getters, `copyTo`, `consolidate`), `NoteEventCollectionBoxAdapter.createEvent`, `NoteRegionBoxAdapter` (truncate, ratchet duration), `ProjectApi.createNoteEvent`, the property lanes (`PropertyAccessor.ts`, chance lane), `PitchPainter`, the note modifiers, the scripting API (`Api.ts`, `impl/timeline/Events.ts`) and tests in studio-core and scripting.

## Box structure

1. `NoteEventBox`
   1. Keeps events, position, duration, pitch, velocity, cent.
   2. Fields 22, 23 and 25 become `deprecated`. Their keys are never reused.
2. `NoteEventChanceBox` (new)
   1. `1 event`: pointer `NoteEventFeature`, mandatory.
   2. `2 chance`: int32, 1 to 100, default 100.
   3. `3 group`: pointer `NoteEventChanceGroup`, optional.
3. `NoteEventChanceGroupBox` (new)
   1. `1 chance`: int32, 1 to 100. While a note is in a group, the group's chance decides and the note's own chance is kept but not used.
   2. Accepts `NoteEventChanceGroup` pointers, mandatory incoming, so a group never exists without members.
   3. No owner pointer. Copying notes copies their group as a dependency, so a pasted or duplicated chord becomes a new group of its own.
4. `NoteEventRepeatBox` (existing, filled in, shown as "Split")
   1. `1 event`, `2 count`, `3 curve`, `4 length` stay as they are.
   2. `4 length`: gate of each split part (1.0 = full part, today's behaviour).
   3. `5 velocity-fade`: float32, bipolar, 0 = none. Negative fades out over the parts, positive fades in.
   4. Further split features get the next keys in this box.
5. One aux box per kind per note, enforced with `exclusive` pointer rules on the kind's own pointer type if the shared `NoteEventFeature` hub cannot express it.
6. Aux boxes are created on the first edit away from the default. A "Clear" action per tab deletes the box of every selected note. Boxes are not deleted automatically when a value returns to the default (dragging through the default would churn boxes).

## Seed and the play decision

### Today

1. The seed is the constant `CHANCE_SEED = 0xFFFF123` in `crates/engine-env/src/note_sequencer.rs`. It is not stored in the project.
2. Every `NoteSequencer` (one per note track) owns one `Mulberry32` stream, seeded once at construction and never reseeded.
3. In every audio block, `process_collection` iterates all notes in `[from - maxDuration, to)` and draws one number for each note with chance below 100, also for notes that do not start in this block. Only the draw in the block where the note starts decides.
4. So whether a note plays depends on how many draws happened before: block size, playback start position, other notes, how long the track has existed. Two renders of the same project differ, and starting playback one bar later changes all outcomes.

### New

1. The base seed is stored in the project: `TimelineBox` gets a field `seed` (int32), next to the key track.
2. Later, a seed track (like the key track) gives a seed per position. The seed in effect at a pass start overrides the base seed. Without a seed track the base seed applies.
3. No stream anymore. The decision is a pure function, computed when a note start is reached:
   1. Ungrouped note: `plays = hash(seed, noteKey, start) < chance`. `start` is the global position (ppqn) of this occurrence of the note. `noteKey` is derived from the note box uuid.
   2. Grouped note: `plays = hash(seed, groupKey, passStart) < groupChance`. `passStart` is the global position where the current pass of the region begins (the region start, or the start of the loop cycle). `groupKey` is derived from the group box uuid. Every member in the same pass computes the same value, so all play or none, even if the members start at different positions.
4. The same project, seed and position always give the same result, independent of block size and playback start. Changing the seed gives a new variation.
5. This changes which notes of existing projects play (the old outcome was not reproducible anyway). Approved.

### Host random

1. The host (engine-env) offers one service for all deterministic random values: `HostRandom.value(position, key) -> unit value`.
   1. `position`: global position in ppqn.
   2. `key`: a stable identity of the caller and purpose (note key, group key, later device lane keys).
   3. The seed is resolved by the host at `position`: the seed track value there, otherwise the base seed of the `TimelineBox`.
2. The note sequencer is the first user. The play decision above becomes `HostRandom.value(start, noteKey) < chance` and `HostRandom.value(passStart, groupKey) < groupChance`.
3. The hash is fixed and versioned in code. Changing it changes every project's variation, so it gets tests with fixed expected values.
4. Later, separate plans: other devices (Euclid, Spielwerk, Arpeggio, WebCLAPs) use the service instead of their own streams. Exposing it to WebCLAPs needs a new host import and is decided there.

## Engine

1. `note_events.rs` reads only the aux boxes into `NoteEvent` (chance, note key, group key and chance, count, curve, length, fade). The deprecated fields are not read.
2. `note_collection.rs` follows the incoming `NoteEventFeature` pointers of each member note and the group box, like `ValueCollection` follows curve boxes. An edit of an aux box or a group re-reads the affected notes.
3. `HostRandom` lives in engine-env and reads the base seed from the timeline binding. `process_collection` and `play_grooved` ask it for the decision above. The `Mulberry32` stream in the sequencer goes away.
4. Split: `length` shortens each part, `velocity-fade` scales the velocity per part index. Both defaults give today's output.
5. Tests in `crates/engine-env/tests/note_sequencer.rs`: same result for different block sizes and playback starts, group all or nothing over many passes, group members at different positions, seed change gives a different pattern, length and fade per part, split defaults identical to the old output.

## Adapters and API

1. `NoteEventBoxAdapter` keeps `chance`, `playCount`, `playCurve` getters (read from the aux box, default otherwise) and adds `repeatLength`, `velocityFade`, `chanceGroup: Option<...>`. It notifies its collection when an aux box or its group changes.
2. A `NoteEventFeatures` namespace in studio-adapters owns writing: `setChance`, `setRepeat`, `clear*`, `group(notes)`, `ungroup(notes)`. Ungrouping deletes the group once it is empty, in the same transaction.
3. `copyTo`, `consolidate`, duplicate, clipboard, `FlattenNoteRegions`, `MoveContentStart`, region split and loop reset carry the aux boxes. `NoteCopyKeepsFields.test.ts` and siblings get cases for each aux box and for groups.
4. `ProjectApi.createNoteEvent` and `NoteEventCollectionBoxAdapter.createEvent` keep their parameters and create aux boxes when values are not default.
5. Scripting API keeps `chance`, `playCount`, `playCurve` on `NoteEvent` and adds the new split fields and a way to group notes. Additive only.

## Migration

1. `MigrateNoteEventBox` in `packages/studio/core/src/project/migration`: a note with play-count ≠ 1 or play-curve ≠ 0 gets a `NoteEventRepeatBox`, chance ≠ 100 gets a `NoteEventChanceBox`. The deprecated fields are left as they are and never read again.
2. The migration must run before the engine receives the box graph. Verify the order on project load.
3. Tests: an old project with ratchets and chances loads to the same aux values, ratchets render identically in the node engine harness.

## UI

1. The tabs go into the panel left of the piano roll (component `PitchEditorHeader`), which today holds the scale row and the property table. Not into the editor header with snapping and menus. A tab row (Basic, Random, Scale, Split) built from `RadioGroup`. The selected tab is remembered per session.
2. Basic: position, duration, pitch, velocity, cent. This is today's grid minus the moved fields.
3. Random: chance, group (Group, Ungroup, member count), Clear. Room for later random features.
4. Scale: root key selector, scale configurator, scale menu, follow project key. Moved out of the always visible row.
5. Split: count, curve, length, velocity fade, Consolidate, Clear.
6. Mixed values across the selection show `invalid` like today. All inputs of one edit run in one `editing.modify`.
7. Piano roll: grouped notes get a subtle shared marker, split parts paint with their length and fade.
8. The property lanes stay (velocity, cent, chance) and write chance through `NoteEventFeatures`.

## Phases

1. ~~UI tabs on the current fields: Basic, Random (chance), Scale, Split (count, curve). Nothing else changes, so this ships on its own.~~ Consolidate stays in the Edit menu.
2. Schema: new boxes, `seed` on `TimelineBox`, deprecations, `npm run build` (boxes and Rust registry). Verify group box lifetime when its last member note is deleted.
3. Adapters, `NoteEventFeatures`, migration, copy paths, tests in studio-adapters and studio-core. The tabs switch to the aux boxes.
4. Engine: `HostRandom` with the base seed, bindings read aux boxes only, play decision, groups, length, fade, Rust tests.
5. Random tab: groups, seed, piano roll marker.
6. Split tab: length, velocity fade.
7. Scripting API additions and declaration file.
8. Later, separate plans: seed tracks (resolved inside `HostRandom`), devices on `HostRandom`.

## Acceptance

1. An existing project keeps its ratchets and chance values after loading. Ratchets sound identical.
2. Rendering the same project twice, or starting playback at another position, gives the same notes.
3. A chord in one chance group plays all notes or none, over many loop passes.
4. Copying a grouped chord gives an independent group. Undo restores groups in one step.
5. Every tab edits the whole selection in one undo step.
6. `tsc` and tests pass for forge-boxes, studio-adapters, studio-core, scripting, app/studio and the Rust crates.
