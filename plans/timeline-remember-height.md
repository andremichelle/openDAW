# Remember the last track height for new tracks

Use the last completed track resize as the starting height for new tracks. The initial default stays 48 px. The height is remembered across sessions without a Preferences control and does not change existing tracks.

## AI-assisted work

Extracted this change from [the combined timeline PR](https://github.com/polinom/openDAW/pull/2) and adapted it to upstream `next-release`. Reviewed the resulting diff separately from the other feature branches.

## Manual check

Resize a track, add an instrument and an audio track, then reload. Check that newly added tracks use the remembered height and existing tracks keep their own sizes.
