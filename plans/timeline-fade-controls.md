# Make arrangement audio fades easier to grab and shape

Show larger, clip-colored square length handles while hovering over a clip. New fades start straight. Drag a diamond along both axes to shape an existing fade. The point and slope save with the project and share one Undo step. This uses the existing audio curve and project metadata.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Hover an audio clip, pull out each fade, and drag its diamond horizontally and vertically. Undo, then save and reopen to check the diamond position.

## Two-axis drag follow-up

The existing curve math already moves the point horizontally and vertically. On short fades, the square and diamond grab areas can overlap. The old hit test tried the square first, so grabbing the visible diamond could start a length or Shift slope drag instead. Use the painted shape first and the closest handle within the grab radius second. Use the same positions for painting and hit testing, and only test handles on the hovered clip.

Studio type checking and 19 focused tests passed. An isolated Chrome project with a generated WAV verified horizontal and diagonal drags, both fade directions, and a short fade where the overlapping diamond moved without changing the square position. Project graph tests cover save/load, Undo/Redo, and cancel.
