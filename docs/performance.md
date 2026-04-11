# Performance Changelog

## 2026-04-11: AnimationFrame throttle

`packages/lib/dom/src/frames.ts`

`AnimationFrame` was running at the display's native refresh rate (120fps on ProMotion Macs),
doubling UI rendering work for all 31+ subscribers (meters, canvas painters, live stream readers).
Throttled to ~60fps by skipping frames within 16ms of the previous.

## 2026-04-11: UUID.toString hex table hoisted

`packages/lib/std/src/uuid.ts`

`UUID.toString()` recreated a 256-element hex lookup table on every call — 256 string allocations
plus a 256-element array. Hoisted the table to module scope (created once).

## 2026-04-11: TapeDeviceProcessor — eliminate string allocations in hot path

`packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts`

Replaced `Set<string>` + `UUID.toString()` per block per lane with a reusable
`Array<UUID.Bytes>` + `UUID.equals()`. Zero string allocation in the hot path.

## 2026-04-11: BlockRenderer — eliminate iterator/array allocation

`packages/studio/core-processors/src/BlockRenderer.ts`

Replaced `Array.from(Iterables.take(markerTrack.events.iterateFrom(p0), 2))` with direct
`floorLastIndex` + `optAt` lookups. Zero allocations per render quantum.

## 2026-04-11: Scriptable device processors — reduce per-block waste

- **Werkstatt**: Reuse `#io` instance field instead of allocating `UserIO` per block.
- **Spielwerk**: Reuse `#events` array and `#userBlock` instance field.
  Index-based iterator instead of closure over `events[Symbol.iterator]()`.
- **All three** (Werkstatt, Apparat, Spielwerk): `parseUpdate()` regex replaced with cached
  `#pendingUpdate` set by code subscription. No regex in the audio-thread hot path.

## 2026-04-11: Maximizer — cache headroom gain

`packages/studio/core-processors/src/devices/audio-effects/MaximizerDeviceProcessor.ts`

Cached `dbToGain(MAGIC_HEADROOM - threshold)` as `#headroomGain`, updated in `parameterChanged()`.
Eliminates one `Math.exp` per sample on the master bus during steady state (~99.9% of the time).
