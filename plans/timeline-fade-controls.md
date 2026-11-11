# Make arrangement audio fades easier to grab and shape

Show larger, clip-colored square length handles while hovering over a clip. New fades start straight. Drag a diamond along both axes to shape an existing fade. The point and slope save with the project and share one Undo step. This uses the existing audio curve and project metadata.

## AI-assisted work

Extracted from a combined timeline branch and adapted to `next-release`, then reviewed as its own diff.

## Manual check

Hover an audio clip, pull out each fade, and drag its diamond horizontally and vertically. Undo, then save and reopen to check the diamond position.

## Hit testing

On short fades the square and diamond grab areas overlap. The painted shape wins first, then the closest handle within the grab radius. Painting and hit testing share the same positions, and only the hovered clip is tested.
