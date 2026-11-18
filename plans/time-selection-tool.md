# Time Selection Tool (#460)

Delete or insert a section of time on one track, several tracks or the whole song, no matter whether the section holds regions or is empty.

## Tools

1. Two timeline tools: **Pointer** (today's behaviour, default) and **Time Selection**.
2. One key per tool: `V` Pointer, `T` Time Selection. Both are free in the global and regions scopes (`Shift+T` and `Shift+Alt+V` are taken, the plain keys are not). The software MIDI keyboard also uses `T` and `V`, verify it keeps priority while it is on.
3. Two toggle buttons next to the SnapSelector in `TimelineHeader.tsx`, with shortcut tooltips.
4. The tool is a UI state, not saved in the project. It starts as Pointer.

## Pointer tool

1. Nothing changes. Copy (Cmd), mirrored copy (Shift), cut (Option), selection rectangle, resize, fades stay bit identical.

## Time Selection tool

1. A drag anywhere in the tracks area, on regions or empty space, draws a range. The region tools and the selection rectangle are not engaged.
2. The range always snaps to the current snapping.
3. Without Shift the range covers the tracks the drag crosses. With Shift it covers all tracks plus the global tracks (markers, tempo, signature, key, chord).
4. The range is drawn as an overlay. Dragging its body moves it, dragging an edge resizes it, both snapped.
5. Right click inside the range opens its menu: Delete Time, Insert Time.
6. Escape, a click outside the range or switching to the Pointer tool removes it.

## Actions

1. **Delete Time** (`Delete`): on every track of the range, split regions at both range edges, delete what lies inside, move every later region left by the range length. With global tracks, events inside are removed and later events move left.
2. **Insert Time** (`Cmd+I`, like Insert Silence in Ableton): clears the range by pushing. On every track of the range, split regions crossing the range start and move everything from the range start right by the range length. Nothing is deleted. Same for global tracks.
3. Each action is one undo step. The range stays at its position after the action.
4. Automation lives in value regions on their own tracks, so it follows the tracks the range covers.

## Steps

1. ~~Research~~ (other DAWs: tools are the common core, click zones rejected).
2. ~~Tool state + shortcuts + header buttons.~~
3. ~~Range model (position, duration, track indices, global flag) + overlay rendering.~~
4. ~~Range gestures: create, move, resize, Escape, click outside.~~
5. ~~Delete Time + Insert Time on regions (reuse `RegionEditing.cut`), tests for empty gaps, regions crossing both edges, looped and audio regions.~~
6. ~~Global tracks for both actions, tests.~~
7. ~~Range context menu + action shortcuts.~~
8. ~~Manual + changelog.~~

## Rules

1. A range over a folded track group covers the tracks inside it.
2. A frozen audio unit in the range asks to unfreeze it and stays unfrozen after the edit. Declining cancels the action.