# Make arrangement audio fades easier to grab and shape

Show larger, clip-colored square length handles while hovering over a clip. New fades start straight. Drag a diamond along both axes to shape an existing fade. The point and slope save with the project and share one Undo step. This uses the existing audio curve and project metadata.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Hover an audio clip, pull out each fade, and drag its diamond horizontally and vertically. Undo, then save and reopen to check the diamond position.
