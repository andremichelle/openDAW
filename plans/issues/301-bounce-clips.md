# Bounce clips to audio (#301)

**Type:** feature
**Scope:** medium
**Status:** implemented on branch `bounce-clips`, Chrome check pending

## What is asked

Right click one or more regions and choose "Bounce". Each region is rendered solo through its instrument and lands as an audio region on a new audio track directly below, at exactly the same position. The original is muted.

## Decisions

1. **Which regions.** Note regions and audio regions on the timeline. Automation regions and clip launcher clips are out of scope.
2. **Several regions.** Each region is bounced on its own by default. A "Merge" option renders all selected regions of the same audio unit into one region, from the first start to the last end, with silence in the gaps. Regions of different units never merge.
3. **Tap point.** A choice of three, like Bitwig:
   1. Pre FX: the instrument output only (for an audio region this still bakes stretching and fades).
   2. Pre Fader: after the effect chain, before volume and panning.
   3. Post Fader: after volume and panning.
   Sends are never included. They feed other buses and are not part of the unit's own signal.
4. **Tail.** Option, off by default. Off ends exactly at the region end. On keeps rendering until silence, at most 30 seconds past the end, so the bounced region can be longer.
5. **Original.** Muted after bouncing. One undo step reverts everything (new unit, new regions, mutes). The rendered samples stay in storage, like Flatten.
6. **Target track.** One new Tape unit per source unit, inserted directly below it, named `<unit name> Bounce`. Every bounce of one action from that unit lands on its one track.
7. **Sample library.** Bounced samples are filed into a root folder "Bounces" of the local sample structure (`samples/v2/structure.json`), created on first use. A sample the user already filed elsewhere stays there, an identical render that sits in the trash is taken out of it. No metadata change.
8. **Overlaps.** Bounces of one unit that would overlap (a tail, or regions on parallel tracks) go onto further audio tracks of the same Tape unit.
9. **Loop.** Option, off by default. Renders one pass of the region loop (from the loop start, ignoring the region's loop offset) twice and keeps the second pass, so effects ring into the start the way they do while looping. The bounced region keeps the source position, length and loop offset and loops the rendered pass. Tail and Merge do not apply and are hidden.

## Existing building blocks

1. `AudioConsolidation.flatten` (`packages/studio/core/src/AudioConsolidation.ts`) is the template: copy the project, delete what must not sound, render one stem offline, `sampleService.importFile`, `AudioFileBoxFactory.createModifier`, then `AudioContentFactory.createNotStretchedRegion` inside one `editing.modify`.
2. The three tap points already exist in the stem export, see `ExportStemConfiguration` (`packages/studio/adapters/src/EngineProcessorAttachment.ts`) and `stem_tap` in `crates/engine/src/audio_unit/mod.rs`:
   1. Pre FX: `useInstrumentOutput: true`
   2. Pre Fader: `skipChannelStrip: true`
   3. Post Fader: both false
   All with `includeAudioEffects: true` (irrelevant for Pre FX) and `includeSends: false`.
3. `OfflineEngineRenderer.renderSection` already handles frame exact rendering without tail and render until silence (+30 s) with tail. It takes a `MixdownSection` with `passes: 1`.
4. `ProjectApi.createInstrument` takes an `index` for placing the new Tape unit below the source.
5. `RegionContextMenu.ts` holds Consolidate and Flatten, Bounce goes next to them.

## Implementation

### 1. `AudioBounce` in studio-core

New `packages/studio/core/src/AudioBounce.ts`, exported from the index:

```ts
export namespace AudioBounce {
    export type Tap = "pre-fx" | "pre-fader" | "post-fader"
    export type Options = { tap: Tap, tail: boolean, merge: boolean }
    export const bounce = async (project: Project, sampleService: SampleService,
                                 regions: ReadonlyArray<AnyRegionBoxAdapter>, options: Options,
                                 abortSignal?: AbortSignal): Promise<void> => {...}
}
```

1. Keep only note and audio regions. Group them by audio unit, sort each group with `RegionCollection.Comparator`.
2. Build the jobs: one per region, or one per group with `merge` (range = first position to last complete).
3. For each job:
   1. `project.copy()`, then in one transaction delete every region of that unit (all its tracks) that is not part of the job, unmute the job's regions, and clear mute and solo on the unit and its tracks so the stem is never silent.
   2. `OfflineEngineRenderer.renderSection` with a one stem `ExportConfiguration` for the unit (tap from options) and `{start, end, passes: 1, tail}`.
   3. `sampleService.importFile` named `<unit> <region label>`, then filed into the "Bounces" folder.
   4. `AudioFileBoxFactory.createModifier`, collected for the final modify.
4. Jobs run one after another under one `RuntimeNotifier.progress` dialog ("Bouncing 3 of 7..."), cancel aborts the remaining jobs and discards everything (nothing is written to the project).
5. One `project.editing.modify`:
   1. Per source unit, create a Tape unit via `createInstrument` at `index + 1` named `<unit> Bounce`.
   2. Create a not stretched audio region per job at the job's start on that unit's track, labeled like the source region.
   3. Set `mute` on every source region.
   4. `project.trackUserCreatedSample` per sample.

### 2. Dialog and menu

1. `RegionContextMenu.ts`: "Bounce..." item, selectable when the selection contains at least one note or audio region.
2. Small options dialog before rendering, in the style of the mixdown dialog:
   1. Tap: Pre FX, Pre Fader, Post Fader (default Pre Fader).
   2. Tail checkbox (default off).
   3. Merge checkbox, only shown when one unit has more than one selected region (default off).
   4. Loop checkbox (default off), hides Tail and Merge.
   5. Layout follows `SampleDialogs`: `auto 1fr` grid with "Label:" cells, no font sizes of its own.
3. Last used options are kept for the session (module level models, like the mixdown dialog).

### 3. Sample library "Bounces" folder

`AudioBounce.fileInto` adds the new uuids to the "Bounces" root folder of `SampleStorage.structure`, then `ProjectSignals.StorageUpdated` reloads the browser.

## Tests

1. `packages/studio/core/src/AudioBounce.test.ts`: jobs, taps, copy preparation, tail detection, lanes, folder filing, `renderFrames` stepping, the edit and its undo.
2. `packages/studio/core-wasm/test/audio-bounce.test.ts`: the real engine renders the prepared copy as a one stem export through `AudioBounce.renderFrames`. Exact length, start position, Pre FX vs Pre Fader vs Post Fader, tail with a delay, tail cap, solo of the region, mute and solo handling, merged gap.

## Open points

1. Composite instruments and buses: `stem_tap` covers them, needs one manual check that a bounced composite region sounds right.
2. Regions whose unit has a sidechain input from another unit: the other unit still plays in the copy, so the sidechain is kept. Accepted for v1.
