# Split selected arrangement clips at the playhead

Add Cmd/Ctrl+E and a Split at playhead menu action. Split selected clips that cross the playhead in one Undo step. Keep only the original left pieces selected, matching Option/Alt-click.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Place the playhead inside one or more selected clips. Press Cmd/Ctrl+E, confirm that only the left pieces stay selected, and undo.
