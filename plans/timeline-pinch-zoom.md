# Pinch to zoom across timeline and editor content

Use a trackpad pinch over arrangement lanes and editor content to zoom the time axis around the pointer. The gesture uses the ruler's existing scaling. Ordinary scrolling and the editor's left controls keep their existing behavior.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

On a Mac trackpad, pinch over the arrangement and the note or audio editor. Check that the time axis zooms around the pointer and that ordinary scrolling still works.
