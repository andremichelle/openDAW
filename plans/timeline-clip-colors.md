# Show inline color swatches in clip menus

Place the six existing clip colors at the top of arrangement and launcher clip context menus. The compact squares align with menu labels, share the existing palette, and apply to selected clips in one Undo step.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Open each clip menu, choose a swatch for a selection, and undo. Check the selected-color outline and that the Groove action remains available.
