# Duplicate selected arrangement clips in place

Cmd/Ctrl+D and the region menu duplicate the selected clips on their current tracks, immediately after the selected time span. The copies become selected so the shortcut can be repeated. Track-header duplication remains available.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Select a clip, press Cmd/Ctrl+D twice, then undo. Repeat with clips on multiple tracks and check that the copies keep their spacing and original tracks.
