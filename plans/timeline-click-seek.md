# Seek by clicking the arrangement or editor

Click the arrangement, Markers lane, or content editor to move the playhead to the snapped position. This works while the transport is stopped and can be turned off in Preferences. Dragging, modifier clicks, and ruler behavior keep their existing actions.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

With transport stopped, click a region, an empty lane, a marker lane, and the note grid. Check snapping. Repeat with playback running and with the preference turned off.
