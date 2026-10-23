# SMPTE.fromSeconds carry

AI-assisted: this change was written with Claude Code (an AI coding assistant).

## Process
- Read `packages/lib/dsp/src/smpte.ts` looking for off-by-one errors at unit boundaries.
- Found that `fromSeconds` rounds subframes to the nearest of 80 without carrying, so a position just below a frame boundary yields `subframes: 80`. Floating point makes this reachable at ordinary positions: 3725.2 s at 25 fps gave frame 4, subframe 80 instead of frame 5, subframe 0.
- Wrote failing tests first (exact split, carry into the next frame, carry across second/minute/hour, and a sweep asserting `subframes < 80` and `frames < fps`), then changed `fromSeconds` to carry subframes into frames, frames into seconds, and derive minutes and hours after the carry.
- Ran the `@opendaw/lib-dsp` vitest suite, tsc and eslint on the touched source file.

## Not covered
- The clock display in `AbsoluteUnitDisplay.tsx` was not checked in a browser.
- Simplified on merge: one rounding on the subframe grid of the second, one carry into the next second. At 29.97 fps the carry happens at 2397.6 subframes.
