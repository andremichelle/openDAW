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

### @opendaw/studio-boxes, @opendaw/studio-adapters: every bus is a group bus

A unit is a group when its type is `AudioUnitType.Bus`. Routing a unit's output into any bus makes it a member of that bus. The `is-group` field is deprecated (no longer read or written).

| Before                                  | After                                                                |
|-----------------------------------------|----------------------------------------------------------------------|
| `unit.isGroup.getValue()`               | `AudioUnitGroups.isGroup(unit)`                                      |
| `unit.isGroup.setValue(true)`           | create the unit with `AudioUnitType.Bus`                             |

### @opendaw/studio-boxes, @opendaw/studio-adapters, @opendaw/studio-core: view states are per user

Group collapse, automation collapse and lane heights live in `ViewStateBox` entries of each user's `UserInterfaceBox` (field `view-states`). The old box fields are deprecated: they are still read once to migrate existing projects into the first user, but no longer written.

| Before                                          | After                                                                       |
|-------------------------------------------------|-----------------------------------------------------------------------------|
| `unit.groupCollapsed`                           | `project.userEditingManager.viewStates.groupCollapsed(unit)`                |
| `unit.userInterface.automationCollapsed`        | `project.userEditingManager.viewStates.automationCollapsed(unit)`           |
| `audioUnitBoxAdapter.automationCollapsed`       | `project.userEditingManager.viewStates.automationCollapsed(adapter.box)`    |
| `unit.userInterface.height`                     | `project.userEditingManager.viewStates.height(unit)`                        |
| `track.height` (`TrackBox`)                     | `project.userEditingManager.viewStates.height(track)`                       |
| `new AudioUnitLayout(root)`                     | `new AudioUnitLayout(root, isCollapsed)`                                    |
| `AudioUnitGroups.hidden(unit)`                  | `AudioUnitGroups.hidden(unit, isCollapsed)`                                 |

The `viewStates` values are `MutableObservableValue`s. Set them inside an editing transaction. A value that was never changed by the user reads its default (`false`, `0`).

### @opendaw/lib-box: a failed undo or redo step is dropped

`BoxEditing.undo()` and `redo()` still roll back a step that cannot be applied (in a live room another participant may have changed what it touches) and return `false`, but the step is now removed from the history, so the next call reaches the older step.

### @opendaw/studio-core: `FFmpegWorker.load` takes the core URLs

`FFmpegWorker.load(progress, urls?)` accepts `{coreURL, wasmURL}` (type `FFmpegCoreURLs`) to load the ffmpeg core from your own host. `package.opendaw.studio` only allows requests from `opendaw.studio`, so other origins must host `ffmpeg-core.js` and `ffmpeg-core.wasm` (`@ffmpeg/core` 0.12.6, `dist/esm`) themselves. Without `urls` nothing changes (`FFmpegWorker.DefaultCoreURLs`). The first call wins, a later call with other URLs reuses the loaded core.

### @opendaw/studio-core: `OpusConverter` encodes stereo

Stereo sources failed inside `@ffmpeg/core` 0.12.x with `RuntimeError: memory access out of bounds`. `OpusConverter` now encodes sources with more than one channel with `-mapping_family 255` (channels coded independently). Mono output is unchanged.
