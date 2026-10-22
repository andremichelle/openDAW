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

`AudioUnitGroups` supplies hierarchy, depth-first order and visibility. `Project.grouping` owns undoable
membership, ordering, routing and duplication operations. `Project.trackSelection` is local UI state,
independent of active device editing and clip/region selection. Hidden rows leave timeline hit testing.

Moving into a folder routes the moved root to its bus. Moving out routes it to the new parent or primary
output. This replaces custom output routing when membership changes; a moved subtree keeps its internal
routes. Containment and primary-route/aux-send feedback checks reject invalid destinations. Cross-folder
grouping uses the closest common ancestor.

New buses initialize at their final output destination. Retargeting a new box in its construction transaction
can leave resolved adapters stale because initial pointer notifications are deferred. Same-project duplication
therefore maps external parent/output references before constructing copies. General transfers retain their
independent-copy semantics. Ordering uses a pre-transfer tree snapshot before deferred pointers settle.

Timeline and mixer use captured-pointer channel dragging with cancellation. Native device/internal-lane
payloads remain separate. Region canvases repaint on visibility re-entry: hiding can clear a previously drawn
canvas even when its data has not changed. Group overview paints coalesce graph/range changes into a frame.

Realtime, offline and stretch WASM URLs and emitted paths include the Studio build UUID. This prevents an
already-cached older engine from loading with a new editor/processor after a schema update.

## Limits

- Clipboard Copy/Cut is disabled for group roots; Duplicate preserves their full subtrees.
- Ungroup removes the folder's effects, gain, mute/solo and automation rather than copying them onto children.
  This can change the sound.
- `.od` storage and `.odb` bundles retain membership and collapse. A lossless DAWproject group round trip is
  not implemented.
- Folded overview lines summarize arrangement regions, not launcher playback or editable content.

## Validation and AI-assisted process

This feature was implemented with Codex and iterated from manual founder testing. Feedback drove the unfold
redraw fix, folded overview, group resizing, header drag area, selection highlight, direct rename, duplicate
placement, and matching header menus. The implementation and tests are included for maintainer review.

Validation on the submission branch is recorded in the PR. Coverage includes:

- Core regressions for grouping, nesting, routing, invalid moves, serialization, selection, duplication and undo/redo.
- Existing adapter transfer regressions and Studio tests, plus overview layout and canvas re-entry regressions.
- Real WASM renders for nested unity gain, collapse, mute/solo, group effects and moving out. Live graph sync
  tests create a subgroup and duplicate a child while parent effects remain active, measuring the output.
- Browser checks for range/toggle selection, grouping, precise drag in/out, collapse/unfold repaint, colored
  overview lines, resizing, renaming, duplicate placement, equal right-click/button menus, and save/reopen.

Synthetic render checks do not establish a subjective listening assessment or full native-DAW parity.

Group-delete follow-up: Delete and Ungroup are distinct. A leaf-first subtree deletion removes descendant tracks, content and processing; Undo restores the hierarchy and routes. Core: 766 tests passed; real WASM: 2 tests passed, including silence after deleting a live nested group.
