# Keep audio fades on the original edges when splitting

A split audio clip keeps its original fade-in on the left piece and fade-out on the right piece. The new cut edges have no fades. Preserve the outer slopes and limit each fade to its remaining clip length. The same rule applies when removing a middle section.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Add fades to both ends of an audio clip, Option/Alt-click to split it, and check that only the outer edges have fades. Undo and try cutting inside a fade.
