# Automation clip labels: parameter name at draw time (follow-up to #212)

**Type:** feature (completes #212 on the clip-launcher surface)
**Scope:** small — one shared helper, the value-clip visitor, tests.
**Assisted:** Claude Code. Verified against the #212 implementation (commit `0ab4a90c7`) before editing.

## Context

Issue #212 made automation labels render the bound parameter's name, composed at draw time, instead of the
literal "Automation". The label is stored empty and `TimelineLabels` composes the visible string from the track's
`targetControlName` plus any custom text (`MigrateDefaultLabels` clears the old stored defaults).

That work landed for **value regions** (the arranger): `TimelineLabels.forRegion`'s
`visitValueRegionBoxAdapter` composes `parameter` / `parameter · custom`. But the **value clip** path
(`TimelineLabels.forClip`'s `visitValueClipBoxAdapter`) was left returning the raw stored `label`. Because
clips are now created with an empty label and the migration clears the old "Automation" default, an
automation **clip** in the clip-launcher renders **nothing** instead of its parameter name — the exact gap
issue #212 set out to close, just on the other surface.

## Root cause

`ValueClipBoxAdapter` already exposes `trackBoxAdapter: Option<TrackBoxAdapter>` and
`TrackBoxAdapter.targetControlName: Option<string>` — the same accessors the region path uses. The clip
visitor simply did not use them:

```ts
visitValueClipBoxAdapter: ({label}: ValueClipBoxAdapter): string => label   // ignores the parameter
```

## Fix

Extract the region path's composition into a shared `composeValueLabel(label, trackBoxAdapter)` and use it in
**both** the region and clip visitors, so the two surfaces stay identical by construction (parameter name,
`parameter · custom` when a real custom label is present, `N/A` when the parameter cannot be resolved, and
the "never repeat the parameter name" guard for recorded automation). No behavioural change to note/audio
labels.

## Tests

`TimelineLabels.test.ts` — new `TimelineLabels.forClip` block mirroring the existing `forRegion` cases
(parameter name when unlabelled, custom appended, parameter never repeated, `N/A` fallback on an unresolvable
track). Proven RED→GREEN: reverting the clip visitor to `label` fails exactly those four cases.

## Verification

- `TimelineLabels` suite: 9 passed (5 region + 4 new clip).
- Touched files add no new `tsc --noEmit` errors and no new eslint errors (the file's pre-existing
  `no-namespace` is repo-wide baseline, unchanged by this diff).
