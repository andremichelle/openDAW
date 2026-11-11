# Copy and paste arrangement clips without copying tracks

Cmd/Ctrl+C and X use the focused arrangement editor when clips are selected. Click a compatible destination lane, set the playhead there, and paste. The clip lands at that position without adding a track. Copying from a track header still copies the track.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Copy a clip, click a compatible lane, set the playhead on the ruler, and paste immediately. Confirm that the source remains, the destination has a copy at the playhead, and no track was created.
