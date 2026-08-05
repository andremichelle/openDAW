# Performance Optimisation — Status

All items implemented. See `docs/performance.md` for the full changelog.

## Test Suite [DONE]

`/performance` page benchmarks every device using real projects rendered via `OfflineEngineRenderer`.

## Completed Optimisations

### Engine / Infrastructure
- AnimationFrame throttled to 60fps (was 120fps on ProMotion)
- UUID.toString hex table hoisted to module scope
- TapeDeviceProcessor: UUID.equals instead of Set\<string\> + UUID.toString
- BlockRenderer: direct lookups instead of iterator/array allocation
- Scriptable devices: reuse objects, cache parseUpdate result
- Maximizer: cache headroom gain

### DSP
- Resampler: bitmask circular buffer indexing (was modulo)
- Dattorro Reverb: flattened delay structure, cached references, inlined cubic interpolation
- Fold: Math.floor instead of Math.round, split loop by ramp state, inlined wavefold

## Remaining Investigation

The original ~2x CPU regression has not been fully explained by any single change.
The `/performance` page now provides a baseline for tracking future regressions.
A `git bisect` between January (`706a7e56`) and HEAD remains the most reliable way
to identify the exact commit if the regression persists.
