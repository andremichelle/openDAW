# Select tracks from arrangement lane clicks

Click a region or its lane to select the track. Use Shift for a range and Cmd/Ctrl to toggle tracks. A drag, canceled gesture, or Option/Alt edit leaves track selection alone. Selection uses the same rules as the track headers.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Click a few tracks in the arrangement, Shift-click across them, then Cmd/Ctrl-click one to toggle it. Drag a region and verify that the track selection remains.
