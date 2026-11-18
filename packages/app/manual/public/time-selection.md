# Time Selection

The timeline has two tools in its header, between the plus button and Follow Cursor.

- **Pointer** (V) selects, moves, copies and cuts regions, as always
- **Time Selection** (T) selects a stretch of time to delete or insert, empty or not

---

## 1. Select Time

1. Press **T** or click the Time Selection tool
2. Drag anywhere on the tracks, over regions or empty space

The range snaps to the grid and covers the tracks you drag across. Hold **Shift** while dragging to cover all tracks
and the global tracks (markers, tempo, signature, key and chords). A drag in the global tracks always covers
everything.

- Drag inside the range to move it, also up and down to other tracks
- Drag an edge to resize it
- **Escape**, a click outside or switching to the Pointer tool removes it

A folded group bus in the range takes the tracks inside it along. Hidden automation lanes of a covered track are part
of the range too.

---

## 2. Delete Time

Right-click inside the range and choose **Delete Time**, or press **Delete**.

Everything inside the range is removed and everything after it moves earlier, closing the gap. Regions crossing an edge
are cut there. Use it to remove a bar from one track, or with Shift from the whole song.

---

## 3. Insert Time

Right-click inside the range and choose **Insert Time**, or press **Cmd+I** (Ctrl+I).

Everything from the start of the range moves later by the length of the range, leaving it empty. A region crossing the
start is cut there. Nothing is deleted.

---

## 4. Cleanup Inaudible Content

A cut region keeps all its notes and automation points, even those it can no longer play. When Delete Time or Insert
Time would leave such content behind, openDAW asks first. **Remove** deletes it together with the edit, **Ignore** keeps
it. Content shared with mirrored regions is never touched.

---

## 5. Frozen Tracks

If a [frozen track](/manuals/freeze-audiounit) is part of the range, openDAW asks first. Confirm to unfreeze and edit
it, then freeze it again when you are done, or cancel to leave everything as it is.

Each Delete Time and Insert Time is one undo step.
