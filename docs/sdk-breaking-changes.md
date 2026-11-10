# SDK Breaking Changes

Changes to the public API of the `@opendaw/*` packages that require SDK consumers to update their code.

## Unreleased

### @opendaw/studio-core: `TimelineFocus` is now `TrackFocus`

The focus only holds the focused track (lane). The region focus was never read and is removed.

| Before                                  | After                                                                |
|-----------------------------------------|----------------------------------------------------------------------|
| `TimelineFocus`                         | `TrackFocus`                                                         |
| `project.timelineFocus`                 | `project.trackFocus`                                                 |
| `timelineFocus.focusTrack(track)`       | `trackFocus.focus(track)`                                            |
| `timelineFocus.focusRegion(region)`     | `region.trackBoxAdapter.ifSome(track => trackFocus.focus(track))`    |
| `timelineFocus.region`                  | removed, use the region selection or `userEditingManager.timeline`   |
| `timelineFocus.clearRegionFocus()`      | removed                                                              |

`track` and `clear()` are unchanged.
