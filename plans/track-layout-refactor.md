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
- Current refactored build: `29a428cd-eaff-4faf-82cf-69c7bd323d1e` (2026-10-28 latest-main refresh).
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

## Configurable ungroup shortcut (2026-10-28)

Shift+Cmd+G on macOS / Shift+Ctrl+G elsewhere invokes Ungroup (Keep Tracks). Its `ungroup-tracks`
action is in the existing Global shortcut definitions, so Preferences > Shortcuts > Global provides
editing, Apply, reset and JSON import/export alongside Group selected tracks. The track menu displays
the configured binding and uses the same action. Existing saved shortcut maps retain their choices and
receive the new default when the action is absent.

The command ungroups selected groups (deepest first for selected nested groups), preserves their tracks,
and selects the promoted children. With an empty explicit selection it uses the edited group. Ordinary
tracks are ignored. Group changes and promoted-track editing focus share one undo transaction.

Validation: Studio type check and production preview build pass. 25 focused Studio tests cover the new
command, nested multi-group undo/redo, edited-group fallback, saved custom shortcut round trips, and
neighboring instrument/drag behavior. Hosted Shift+Cmd+G removes a selected subgroup and one Undo restores
it; Preferences shows the default binding, and its edit dialog captures an alternative without conflict.
The trial alternative was canceled, leaving the default unchanged. Saved the restored verification project.
Comparison build: `0f712c2e-a396-49db-bb38-c93e7993c209`; CloudFront invalidation
`I1IPWK7JEMGZHY0DNJWGCXUZ1M` completed. Original comparison demo remains unchanged.

## Latest official-main refresh (2026-10-28)

Rebased the 34 grouping commits onto official `main` at
`ba563e7bf5ab5e8b3e53491677ca10c049bc125f`. Rollback source:
`3f16a04dc2f8a07dd80d514fd302457f2a956e22`, retained locally as
`codex/track-groups-before-main-refresh-2026-10-28`. The only conflict was ProjectApi imports;
keep the upstream audio-composite boxes/EffectFactories alongside the grouping imports.
Range-diff preserves all grouping commits, with import/context adaptations only.

Upstream's custom-only ShortcutStorage and legacy-screen-key migration remain intact. A new integration
regression migrates the older saved Group/Ungroup bindings, retains both custom bindings, applies the
new screen defaults, writes only custom values, and reloads the migrated preferences.

Refresh validation: production dependency/Studio build passes all 25 tasks. Core passes 887 tests / 86
files; adapters 360 / 31; Studio 251 / 41; real-WASM grouping plus MIDI Output 13 / 2. The first core run
hit the existing five-second large-state collaboration test timeout during parallel checks. The full
core rerun passes with two workers and unchanged assertions/timeouts. Studio also uses two workers.

Published rebased comparison build `29a428cd-eaff-4faf-82cf-69c7bd323d1e`; invalidation
`IHV2XSRHCFMYXCGVDZDVWLYFN` completed. Public metadata/deep-link responses use no-cache; the versioned
engine has correct WASM MIME/magic and immutable caching, with COOP/COEP retained. The original demo is
still build `1efc199a-bc44-4479-bcb4-dfdfe771f00d`. Prior comparison entry files are retained locally at
`/tmp/group-main-refresh-rollback`; old hashed assets remain available.

Hosted checks open the existing saved nested-group project on the rebuilt engine, verify mixer routing,
run Shift+Cmd+G and one Undo, then save/reopen with both groups restored. No browser console errors.
Screenshot: `/tmp/group-main-refresh-demo.png` (verification artifact only).

## Group insertion and clip launcher (2026-10-28)

New instrument dialogs, Spotlight, presets/racks, audio-track creation and browser drops use a captured insertion with a next-sibling UUID and parent-group UUID. These are transient UI placement data, not box schema fields. The primary group bus is assigned at construction/import; list placement does not repair an already-created output pointer. The last child keeps its parent even when it has no following sibling. Deleted anchors are resolved safely when asynchronous loads finish. Default placement without a selected insertion stays unchanged.

Group launcher tiles show Scene numbers, the existing play/stop symbols and a narrow stacked preview of clip hues. Each tile launches that scene in one existing scheduleClipPlay call. It includes nested/collapsed descendants and the group's own automation tracks, excludes outside units and launches muted clips silently like ordinary clips. Empty child slots continue playing, matching the existing global column launcher. Clicking a queued/playing tile stops the group's tracks only. Waiting/playing feedback follows engine notifications, including restored playing state on remount. Clip edits, routing, track changes and undo refresh the preview; subscriptions exist only while the launcher is visible and release with the row.

No DSP, worklet commands, schema fields or launch quantization changed. PresetDecoder accepts an optional destination bus so imported root routes point at their parent from the start; internal rack routes remain intact.

Validation: production dependency/Studio build (25 tasks); core 887 tests/86 files; adapters 360/31; Studio 259/42; real WASM grouping/MIDI Output 13/2. New regressions cover captured nested insertion (middle/last child, edit-mode fallback, presets, serialized routes and undo/redo), nested/muted clip batches, group automation, scene indices, outside exclusion, playback notifications, rerouting/undo and subscription disposal.

Hosted comparison build `ec9fcd60-d4e3-4938-9163-0eaa5744f526` uses the existing isolated URL. Browser checks verify Add instrument after the last child in a nested group, its matching mixer output, and saved-copy reopening with that route and clip colors retained. The group tiles must set pointer-events and a positive stacking layer: timeline rows otherwise pass input to the transparent clip-selection surface. The corrected release launches three child clips together and shows parent/nested playing states, scene switching and collapsed-folder feedback. No subjective listening assessment is claimed. Previous source remains `f36982d927d93a6e018b0e2fef779d6b8c9cbcc4` for rollback; the original comparison demo is unchanged.

### Simpler group launcher tiles

The launcher tiles now show only the play/stop icon and child color preview. Visible Scene labels and hover/queued outlines are removed. Hover and keyboard focus brighten the icon; playing/queued states use the icon color and stop symbol. Scene numbers remain in accessible labels. Launch scheduling is unchanged.

Verified the Studio production build and four launcher regressions. Comparison build `1d219544-f2a3-4482-8eaa-23f68a1f6171` passes native browser launch/stop checks with no visible Scene text, no outline or box shadow while hovered, and the stacked colors retained. Accessible scene labels remain present.

### Restore launcher headers, retain border-free feedback

The scene header and name are restored, including their queued/playing fill. Hover and keyboard focus still brighten the icon without outlining the tile. Queued tiles also have no outline. This supersedes the icon-only appearance above; color previews and launch behavior remain unchanged.

Studio production build passed. Hosted build `46c5d859-72ac-45d9-b984-32781ec61084` shows Scene names and active header fill, launches/stops the child clips, and reports no outline or box shadow while hovered. No console errors. This change restores the original header markup/styles; clip scheduling is untouched.

## Editable group launcher columns

Group tile headers start blank. Their context menu follows regular clips: Delete, Rename, Mute, Color, Consolidate (when a child is mirrored), and Trigger > Loop. Rename/Color change this group's tile only and retain the descendant-color preview; Delete clears child clips at that index and nested tile appearance; Mute/Loop/Consolidate apply to those child clips, including group automation. Other columns and outside units remain unchanged. Each command uses one undo transaction. An empty tile still opens the menu so it can be named or colored in advance; launching it does nothing.

`GroupClipAppearance` uses the existing MetaDataBox with origin `opendaw.studio.group-clips.v1.<index>`, attached to the group. Names/colors save, collaborate and duplicate with the box graph; they add no AudioUnitBox field or engine change. Header labels use the regular 64-character validator and truncate visually. Hover/queued borders remain absent. Eight focused launcher regressions cover scoped playback/actions, nested deletion/undo/redo, metadata subscriptions, save/decode, duplication, empty naming and outside exclusion.

Verification: 263 Studio tests/42 files and the production Studio build pass. Hosted build `3ddf6106-40d2-48d2-93db-27e10038909e` verifies blank defaults; Rename/Color; naming an empty tile; three-child Mute; Trigger Loop checked-state changes; Delete leaving the other column intact and one Undo restoring clips/name/color; menu Save, Dashboard close and saved-project reopen retaining label/hue/mute/loop. Named/colored groups still launch three clips together on the existing WASM engine with no console errors. Saved fixture: Group launcher menu verification. The original comparison demo is unchanged.


## Shared edit lines and group-colored launcher headers (2026-10-29)

Only the edited audio unit gets a tinted timeline/mixer line; its parent rails remain muted. Explicit multi-selection still highlights all selected names and row backgrounds. AudioUnitSelection.isEdited supplies the state for all three surfaces. A shared Sass mixin supplies one opaque gray mixed with the panel background, or the full unit color. Opaque inactive paint avoids double-opacity shades where a group rail overlaps its own header line. No new left mixer selection stripe is added.

Group launcher headers use their group's color for all columns. Color is removed from their menu; the descendant clip hue preview remains unchanged. Named and empty tiles still work. Existing saved names survive; former per-column hue metadata is ignored. No schema, routing, launch scheduling or audio-engine changes.

Source verification: 43 grouping tests and 263 Studio tests pass; core TypeScript compilation and the Studio production build pass. The grouping regression checks independent explicit selection/edit focus, nested parent exclusion and cleared edit focus. Launcher coverage retains save/decode/duplicate names, old hue metadata compatibility, scoped actions and undo. The clip-selection report and new upstream conflicts are separate outstanding items.

Hosted comparison build `e858c0b8-dbec-451b-9589-3696d59f11b7` verifies two selected names with only the edited child's line tinted, muted parent rails in both views, one shared inactive computed color, group-colored named/blank launcher headers and the menu without Color. The existing saved verification fixture was saved after the check. Screenshot: `/tmp/group-shared-edit-lines.png` (local verification only). Preview-only asset proxy and build-versioned WASM paths are retained in the deployed bundle and excluded from PR source. CloudFront invalidation `I4M4P6L9BEBCA4ZQ2VS8EO2RLO` completed; entry files use no-cache, versioned engine uses immutable caching and application/wasm, and COOP/COEP remain present. The original demo remains build `1efc199a-bc44-4479-bcb4-dfdfe771f00d`.


## Select group clip headers without playback (2026-10-29)

A group tile now has separate native header and playback buttons. Clicking the header selects that group column only; clicking the middle selects it and launches/stops its descendant clips. Selected headers get the existing group-colored fill; playback state changes the play/stop icon independently. Hover/focus still adds no tile border. Context menus remain attached to the whole tile.

GroupClipSelection is local UI state owned/disposed by TracksManager. It never selects descendant clips. Selecting a group tile clears the previous regular clip selection; selecting a regular clip or starting a clip-area gesture clears the group selection. A deleted group clears its tile selection and listeners. Escape clears selection; Delete on a focused selected tile uses the existing scoped column-delete action, rather than deleting an audio unit. No schema, routing or engine changes.

Verification: 265 Studio tests / 42 files and the production build pass. New regressions cover no play/stop side effects, no descendant selection, one selected group/column, regular-clip handoff, deleted-group cleanup and disposed listeners. Hosted build `7031abd0-b682-4f96-ab4b-63f1c024ce60` verifies idle header selection with no launch, middle-click launching three children, clicking same/other headers while those three keep playing without a scene switch, regular header handoff, middle stop, and selected-column Delete/one Undo restoring three clips/name while both groups stay present. Playback was stopped and the verification fixture saved. Screenshot: `/tmp/group-clip-header-selection.png` (local verification only). No browser console errors during the check. Preview proxy/cache patches are excluded from PR source. CloudFront invalidation `I61YZ2VMPGRXGTVDQNBSU5J9CW` completed.

After Save and a full page reload, reopening the verification project retains both groups, all four regular clips (three in the tested column) and the Verse name. Group tile selection is intentionally transient UI state.


## Flush child-color previews (2026-10-29)

Remove the group launcher preview's 3px top/bottom/right insets and its independent corner radius. The child-color strip spans the full playback area below the header and shares the header/tile right edge; 1px separators between child colors remain. This is a Sass-only change. Production Studio build passes. Hosted build `450461ab-e5fd-40d1-b359-d2ed177a6d6e` measures zero top/bottom/right gaps on all four populated preview strips, including the nested group. Header selection still works and the browser reports no console errors. Screenshot: `/tmp/group-color-preview-edge.png` (local verification only).


### Separate the first preview color from the header

The preview keeps its flush right/bottom edges and now starts 1px below the header, matching the separators between child colors. This supersedes the zero top gap above. The production Studio build passes. Hosted build `edb29775-0a17-4e2d-810b-ea1aff67afc3` measures top gap 1px, internal gap 1px, and right/bottom gaps 0px on all four populated strips, including the nested group. Screenshot: `/tmp/group-preview-header-gap.png` (local verification only).
