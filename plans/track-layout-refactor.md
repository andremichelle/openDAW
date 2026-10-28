# Shared flat track layout

## Purpose and design

Timeline and mixer now consume one immutable channel layout instead of independently reconstructing order,
visibility and nesting from graph queries and nested DOM containers. The UI behavior remains the reference
for this architecture change.

`AudioUnitLayout` computes canonical channel order, visible rows, parent/ancestor relationships, depth,
indentation and visible group boundaries. `Project.audioUnitLayout` owns and publishes the snapshot once
per layout-changing transaction. Volume, mute and effect-parameter edits do not rebuild the layout.

`TrackListLayout` expands those channels into a pure, flat timeline projection. It handles content lanes,
automation, synthetic group/bus lanes, hidden Output and the modulator tail. Boundaries map from channel
indices onto actual lane rows. The timeline mounts lanes as siblings; unit backgrounds and group rails
are separate spans. Header padding and guides consume computed offsets. Mixer strips, selection ranges,
drag targets and timeline hit testing follow the same shared order.

## Placement behavior

- A new group replaces the first selected sibling's position. Its children retain their visible order,
  regardless of click order. Cross-folder selections still use the closest common ancestor.
- Saved indices order folders and other channels; Output alone stays last. Explicit drag positions and
  duplicate blocks no longer snap back to bus/instrument/FX sections. New FX creation retains its default slot.
- Creating an instrument from the browser or Add instrument inserts after the selected track, within the
  same parent group. A multiple selection inserts after its last visible selected root. Selecting a group
  inserts after its complete subtree. Repeated additions advance selection to the new channel.
- Browser insertion uses the edited unit when track selection is empty, including after clearing/deleting
  the explicit selection. Explicit drag/drop and low-level creation retain
  their existing APIs.

## Audio and persistence scope

The layout refactor changes no box schema or DSP/WASM processing implementation. Group membership, collapse,
routing and effects originally continued to use the existing grouping model. The subsequent routing-derived
membership update removes the experimental parent/children fields and updates the matching Rust registry;
it adds no DSP algorithms. See `track-groups.md` for the current model and compatibility check.

A newly inserted grouped instrument receives its destination during construction through
`InstrumentOptions.destination`. Repointing a newly constructed channel later in the same transaction can
leave its resolved route inconsistent with its saved pointer. The regression checks both membership and
the resolved group bus, plus serialization and undo/redo. Grouping/moving existing channels now sets their destination, and membership follows the output route.

## Verification

Codex assisted this refactor and its validation. Current checks passed:

- Core: 787 tests / 79 files; adapters: 363 / 30; Studio: 93 / 25.
- Real WASM grouping audio: 2 tests. Production source/preview builds and Studio types pass.
- New tests cover immutable nested snapshots, collapse/undo, one publication per transaction, parameter-only
  edits, pure lane projection, hidden Output, automation/modulators, exact group placement, reversed
  selection, FX-only groups and selection-aware insertion/routing.
- Local browser: an 80-folder project plus a nested subgroup; flat sibling lanes and childless background
  spans, fold/unfold, highlighting, drag out/back in, duplication/undo, mixer fold, clip creation, folded
  overview, immediate repaint, resizing and save/reopen.
- Hosted browser: fresh grouping and insertion examples, mixer order and output routing, and save/reopen.

These are source, regression, UI and persistence checks. No new quantified performance result, subjective
listening assessment or full native-DAW parity is claimed. The earlier performance measurements remain
historical evidence in `track-groups.md`.

## Comparison and rollback

- Refactored demo: https://d3vptcx5s0ph2g.cloudfront.net/
- Original behavior/appearance reference: https://d2194sm5auuuqe.cloudfront.net/
- Current refactored build: `e774216a-88b8-4017-b789-53273ab957e1` (2026-10-28 review follow-up).
- Original demo build: `1efc199a-bc44-4479-bcb4-dfdfe771f00d`.
- Pre-refactor official source: `b4bf236ab6275414f35617a288b1f5976844be5d`.
- Pre-refactor deployed source: `b4848a8a2d9b9cfca0aef9285403ff3d9b4dac0f`.
- Pushed rollback tags: `track-groups-before-layout-refactor-2026-10-22` and
  `track-groups-preview-before-layout-refactor-2026-10-22`.

The original demo remains unchanged. Preview-only stock-asset proxy and WASM cache configuration remain
outside the upstream PR source. The refactor updates the existing PR #496.

Mixer selection follow-up: selected strips use their existing 2px top border instead of a left inset
shadow. Name-label fill/outline and subtle tint are unchanged. Selected folders keep both their
selection border and group rail. The production build and hosted single/multiple-selection checks pass;
unselected borders remain transparent, and no selected strip has an inset left shadow.

## Drag feedback follow-up

`GroupDropLayout` resolves pointer geometry against the shared layout and actual channel/header bounds.
Both sides of a gap use the same canonical marker row. An after-group target is drawn below the complete
visible subtree. End-of-folder and following-root targets share a physical boundary with different
indentation. A hidden Output still permits the final insertion slot.

Group-center feedback uses the primary header height and first grid column. Automation, clip launcher
and arrangement cells are excluded from that frame. Header drag handles own their `data-group-header`
registration; mixer column gaps use the same canonical boundary rule.

This UI-only follow-up passes 102 Studio tests, 36 focused core grouping tests, Studio types and the
production build. Nine new pure geometry tests cover nested/resized/folded groups, automation, launcher
exclusion, hidden Output and mixer gaps. A browser fixture using the actual stylesheet confirms the
inside frame fits the 288px header column (including indentation) and stops before launcher/automation;
the insertion line uses one full-width grid span.

Hosted drag checks move a track onto the group header, between two children, and back to the root. A
108px resized group also accepts a center-header drop. The temporary CSS fixture checks feedback geometry
separately from those completed native gestures; live pointer-hold screenshots are not available through
the current browser automation. Saved the hosted example as `Track drop feedback verification`.

Group-hover appearance follow-up: inside-group feedback uses four 8px corner brackets instead of a
continuous border. Header bounds, indentation and insertion-line geometry are unchanged. The compiled
stylesheet browser fixture verifies the corners stay outside launcher/automation cells and the
insertion preview remains one line. The production preview build passes.

Drop-feedback stacking follow-up: group rails paint at layer 6; timeline drop corners and insertion
lines must paint above them at layer 7. A browser fixture with both actual compiled styles verifies
the rail no longer covers the left corners or the insertion line. Earlier corner checks without a
rail did not exercise this overlap.

Expanded-group hover follow-up: the timeline header's lower quarter no longer resolves to the distant
after-subtree insertion boundary. Expanded headers accept inside drops from 6px below their top through
their bottom edge. The top edge still inserts before the group; insertion after the subtree remains
available below its last visible child. Collapsed groups and mixer hit zones retain both edge targets.
Two new regressions walk upward through resized/nested expanded headers and check collapsed edge
behavior. All 11 geometry tests pass.
The full Studio suite passes 104 tests in 26 files; the production build/type check passes.

Mixer hover follow-up: mixer inside-drop feedback uses the same `drop-corners` Sass mixin as the
timeline, replacing the full strip outline with four 8px brackets. The overlay does not intercept
controls. Expanded mixer groups also keep the inside target through the right edge; their left 6px
remain an insertion-before target, with after-subtree insertion available beyond their children.
Collapsed groups retain both insertion edges. Two new mixer geometry regressions cover nested
expanded entry from the right and collapsed edge targets. All 106 Studio tests (26 files), production
build and type checks pass. A browser fixture using actual mixer/strip/rail styles verifies corners
and separate insertion feedback; this is a style check, not a live held-drag screenshot.

## Routing-derived membership follow-up

Membership now follows the primary output into a group bus. The separate parent/children schema fields
and pointer enum value are removed; identity/collapse remain. Output-menu edits rebuild the shared
layout once per transaction, and group overview redraws follow the route changes. Nested routing, aux
send exclusion, feedback rejection, transfers and old-preview-file decoding are covered in the tests.
This supersedes the earlier independent custom-output/folder behavior. See `track-groups.md`.
Hosted output-menu checks and a saved/reopened copy confirm that both views follow the same routing
hierarchy. The old preview project opened correctly; its original library entry was left unchanged.

## Upstream rebase (2026-10-28)

Rebased all 31 grouping commits onto official `main` at
`dde73478661dba89fd974b97e16fead359920d1d`. The pre-rebase source is
`cc0564033f2e3fd5ca8c04a92c70e0da21480ab7`, retained locally as
`codex/track-groups-before-rebase-2026-10-28`; earlier rollback tags are unchanged.

Conflict resolutions preserve upstream WebCLAP parameter editing, mute/solo/create-track shortcuts
and community-script dragging alongside multi-track grouping and duplication. Group headers continue
to accept audio effects only. Instrument browser creation retains upstream automatic note regions and
selection-aware insertion; an integration regression checks group routing, the new region and one-step undo.

The production Studio/dependency build regenerates matching box/WASM registries and passes all 25 tasks.
Core (876 tests / 86 files), adapters (360 / 31) and the two real-WASM grouping/audio checks pass.
The existing comparison deployments are left unchanged by this source-only rebase.
Studio passes 228 tests in 37 files with two workers. Its first run, concurrent with the other suites,
hit the existing five-second automation-snap test timeout; the full isolated rerun passes with unchanged
assertions/timeouts. `git diff --check` also passes.

## Review follow-up (2026-10-28)

Addressed the source audit in PR comment 6475924787 and the mixer feedback in 6474326622.

- Plain reorders preserve custom bus routes and No Output. Only a change of folder parent rewrites the
  main output. A nested move out still routes to the enclosing group, or master at the root.
- Ordinary channel creation and DAWproject import use the original Instrument/Aux/Bus ordering again.
  Folders retain their chosen sibling positions. Creation shifts only indices at/after the new slot,
  without normalizing every preceding channel. Paste without an edited channel again starts at the
  first matching channel section; explicit paste anchors retain their position.
- Multi-track duplicate, output preservation and insertion after the selected instrument remain
  deliberate requested behavior. Generic transfers no longer expand folders implicitly;
  `includeGroupDescendants` is explicit and enabled by group-aware duplication.
- Hidden content/automation lanes receive listIndex -1 on every layout. Region and launcher clip move
  gestures exclude those lanes, so selected hidden content stays on its original track and position.
  Region move/copy plus undo have regressions.
- TracksManager caches visible TrackContexts until layout invalidation. Per-lane renderer lookups now
  index the cached array rather than rebuilding it. No new measured performance claim is made.
- Folded overviews subscribe only to descendant region/track collections, enabled state and order.
  They rebuild subscriptions when their membership/order changes, and release them while unfolded.
  An unrelated region edit, mixer parameter change or unrelated layout change does not repaint them.
- Empty track selection now restores the edited-unit command fallback. Deleted/deselected Shift anchors
  are cleared. Commands and instrument insertion share AudioUnitSelection.commandTargets.
- AudioUnitGroups.visit is the single hierarchy traversal for ordered queries, flat snapshots and moves;
  duplicate span/walker code is removed. UnitLane/resize use type-only TracksManager imports.
  Rails use JSX; fallible group/routing/drop lookups return Option. Removed the pointer cast and cleaned
  imports, multiple declarations and lambda names in the changed production code.
- Inactive rails are fully desaturated, have no pointer cursor or hover promotion, and retain keyboard
  focus feedback. Mixer gaps resolve at their midpoint; one insertion marker spans to the destination's
  rail depth, and no-op boundaries show no marker. Group inside feedback remains corner-only.

The legacy fixture is explicitly for pre-release preview files, not a released-format migration.
Keep it and reserve keys 31/32 so existing tester projects cannot be misread if those keys are reused.
It adds no fields or runtime migration. The fixture verifies route preservation and resaving.

Validation: 880 core tests / 86 files, 360 adapter tests / 31 files, 231 Studio tests / 38 files;
production dependency/Studio build passes 25 tasks. Tests cover route preservation/undo, bus placement
without preceding index writes, deleted Shift anchors, explicit transfer scope, descendant-only redraws,
hidden region moves/copies and mixer gap geometry. Source before this review: 3bf40ab0a86b2e3276a9e4ab0e6132329dc369e2;
comparison build before this review: 573e4068-1514-4ed9-a97c-90d7fa096e38.

The two real-WASM group audio tests pass. Published comparison build
`e774216a-88b8-4017-b789-53273ab957e1` to the existing refactor prefix only. CloudFront invalidation
`ID1GCEEJ4YMQSKZS7PZG9904AF` completed. Public build metadata and /create return no-cache, versioned
engine WASM returns application/wasm with immutable caching and the correct magic, and COOP/COEP plus
factory sample/community-script endpoints remain available. The baseline build stays
`1efc199a-bc44-4479-bcb4-dfdfe771f00d`. Previous comparison entry files are retained locally in
`/tmp/pr-496-review-rollback` and old hashed assets remain on S3.

Hosted browser checks used a separate saved copy, `PR review fixes verification`: a Neon channel kept
No Output through a native mixer reorder; direct expanded-group drop routed it into the group;
dragging out routed to Output, and Undo restored the group route. Cmd-click deselection followed by
Cmd+G created a nested group around the edited Neon. Double-click rename, save, reload and reopen
preserved the subgroup and routes. Inactive rails compute grayscale(1) with a default cursor; selected
strip still has its top/name indicator. No console errors. Completed native gestures and source geometry
regressions are separate evidence; no live pointer-hold capture is claimed. Screenshot:
`/tmp/pr-496-review-demo.png` (verification artifact, not shipped).
