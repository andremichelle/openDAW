# Nested track groups

## Behavior

A group is an audio bus displayed as a folder in the arrangement and mixer. Its children keep their
instruments, clips, automation and effects. The group accepts audio effects only and starts at unity gain.
Groups may contain other groups.

- Shift-click selects a visible range. Cmd-click on macOS or Ctrl-click elsewhere toggles individual channels.
- Cmd/Ctrl+G or Group Tracks creates a folder from the selection, including a single channel.
- Drag a primary track header to move selected channels. Buttons, knobs and resize handles retain their gestures.
  Drop in a group header's center to append inside; drop at row edges for a specific position. Move left across
  indentation at an edge to leave a folder. Move Out of Group is also available in the menu.
- Collapse hides descendants without changing playback. The folded arrangement row shows thin lines for
  descendant note/audio regions at their original times and colors. Group rows resize and retain their height.
- Double-click a group title to rename it. Right-click and the three-dot button use the same track menu.
- Duplicate keeps copies inside their original parent. Selected sibling copies form one block after the last
  selected sibling, in display order. Selections across folders create a block in each original folder.
  Selecting a folder and its descendant copies the subtree once. New copies become the track selection.
- Delete removes the folder and its complete nested subtree in one undoable action.
- Ungroup (Keep Tracks) promotes the children and removes only the group's processing.

## Model and routing

`AudioUnitBox` fields 31–34 store optional parent membership, children, group identity and collapse state.
`userInterface` field 2 stores synthetic-lane height (0 = default). `Pointers.GroupMember` is appended, keeping
existing pointer ordinals. Old projects default to ungrouped. Generated TypeScript boxes and the Rust/WASM
registry must be rebuilt together after schema changes.

`AudioUnitGroups` supplies hierarchy and command queries; `Project.audioUnitLayout` shares channel order,
visibility, indentation and boundaries between timeline and mixer. See `track-layout-refactor.md`. `Project.grouping` owns undoable
membership, ordering, routing and duplication operations. `Project.trackSelection` is local UI state,
independent of active device editing and clip/region selection. Hidden rows leave timeline hit testing.

Moving between folders updates the output only when it follows the previous folder or primary bus.
Custom output routes remain intact; a moved subtree keeps its internal routes. Containment and primary-route/aux-send feedback checks reject invalid destinations. Cross-folder
grouping uses the closest common ancestor.

New buses initialize at their final output destination. Retargeting a new box in its construction transaction
can leave resolved adapters stale because initial pointer notifications are deferred. Same-project duplication
therefore maps external parent/output references before constructing copies. General transfers retain their
independent-copy semantics. Ordering uses a pre-transfer tree snapshot before deferred pointers settle.

Timeline and mixer use captured-pointer channel dragging with cancellation. Native device/internal-lane
payloads remain separate. Region canvases repaint on visibility re-entry: hiding can clear a previously drawn
canvas even when its data has not changed. Group overview paints coalesce graph/range changes into a frame.

## Limits

- Clipboard Copy/Cut is disabled for group roots; Duplicate preserves their full subtrees.
- Ungroup removes the folder's effects, gain, mute/solo and automation rather than copying them onto children.
  This can change the sound.
- `.od` storage and `.odb` bundles retain membership and collapse. A lossless DAWproject group round trip is
  not implemented.
- Folded overview lines summarize arrangement regions, not launcher playback or editable content.

## Validation and AI-assisted process

Codex assisted implementation, regression tests and browser verification. Iterative testing informed the
interaction and rendering changes. Current validation results are recorded in the PR. Coverage includes:

- Core regressions for grouping, nesting, routing, invalid moves, serialization, selection, duplication and undo/redo.
- Existing adapter transfer regressions and Studio tests, plus overview layout and canvas re-entry regressions.
- Real WASM renders for nested unity gain, collapse, mute/solo, group effects and moving out. Live graph sync
  tests create a subgroup and duplicate a child while parent effects remain active, measuring the output.
- Browser checks for range/toggle selection, grouping, precise drag in/out, collapse/unfold repaint, colored
  overview lines, resizing, renaming, duplicate placement, equal right-click/button menus, and save/reopen.

Synthetic render checks do not establish a subjective listening assessment or full native-DAW parity.

## Performance and ordering

Hierarchy ordering builds parent buckets once. Subtree queries visit child hubs instead of scanning unrelated
channels. Timeline changes coalesce at the graph transaction boundary, before painting and hit testing.
Timeline and mixer consume a shared layout snapshot. Folded overviews ignore effect and mixer parameter edits.

A synthetic browser project with 80 folders and 160 instrument children measured duplicate-to-second-frame
latency of 27.15 seconds before these changes and 0.44 seconds after them. Single-track deletion measured
0.69 seconds before and 0.31 seconds after. These single-run measurements include the browser display cycle
and temporary timing instrumentation; they are not guarantees for other projects or hardware.

Each sibling list follows saved indices, with Output kept last. New groups take the first selected
sibling slot; positioned moves and duplicate blocks retain their requested order. Mixer folders use
the same persistent collapse state as the arrangement and keep their volume, mute, solo and effects controls.

General audio-unit transfers expand group roots to full subtrees, including cross-project and delete-source
transfers. Internal membership is mapped; external membership is omitted unless same-project duplication
explicitly preserves it.


## Maintainer UI review

The layout stays flat. `GroupRails` uses grid spans over the visible, depth-first unit list, so each folder
has a continuous boundary across the existing row/column gaps. Nested folders add inset rails. Selected
group rails cover the complete visible subtree. Clicking a rail selects and reveals its group header.
The mixer displays the boundary above its strips, with space reserved for each nesting level.

Single-lane devices no longer show an isolated tree stub. Captured-pointer mixer handles suppress the
browser focus outline. New-channel insertion skips complete folder subtrees; browser instruments follow the selected track inside its parent group, and new FX buses use their default
slot before Output. Explicit moves retain their requested position; folder subtrees remain contiguous.

Browser checks used the maintainer's examples: create an FX send/bus, drag that bus to another root boundary,
verify its output and the source send remain intact, fold/unfold nested mixer strips, and click long group
rails to reveal their headers. Regression tests cover visible nested spans and FX creation/movement.

Mixer group rails span a reserved row above the strips. Channel selection uses a left-edge bar, title fill/outline and subtle channel tint. The folder toggle sits to the right of its icon. Timeline header backgrounds fill
the indentation area, with square edges and content padding. Boundary drop feedback validates the
source, parent, sibling anchor and Output boundary before showing an insertion marker.

Track selection lines occupy their own depth position after the parent rails. Header backgrounds remain
full-width, so the selection line is painted as a narrow background stripe rather than an outer border
that overlaps the parent rail. Rails are 4px wide with a 5px depth step: one pixel between levels.
Header padding, automation guides and drag-out hit testing use the same depth step.
