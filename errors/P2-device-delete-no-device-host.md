# Effect-device delete — "no device-host" unwrap

- **status:** OPEN (root mechanism identified; trigger unconfirmed) · **priority:** P2
- **occurrences:** 1 · **ids:** [1015]
- **assessment:** `Devices.deleteEffectDevices` calls `adapter.deviceHost()` on each device to delete. `deviceHost()` unwraps `box.host.targetVertex` with `"no device-host"`. The device being deleted has an **empty `host` pointer** (orphaned / already detached), so the unwrap panics.
- **action (proposed):** Make `deleteEffectDevices` resilient to a device whose `host` pointer is absent (skip / filter such devices rather than unwrap-panicking). Confirm the upstream cause (how a still-listed effect loses its host pointer). Do NOT mark fixed until shipped + tested.

[< back to index](error-triage.md)

## Reports

### Error: Error: no device-host
- **occurrences:** 1 · **ids:** [1015] · **span:** 2026-06-17 · **builds:** 1 (6abdd11c) · **browsers:** Chrome/ChromeOS
- **stack (source-mapped):**
  - `at h (lib/std/lang.js:49 (panic))`
  - `at Option.unwrap (lib/std/option.js:39 (panic))` → `"no device-host"`
  - `at <DeviceBoxAdapter>.deviceHost (main…js)` → `this.#box.host.targetVertex.unwrap("no device-host")`
  - `at deleteEffectDevices (main…js)`
  - `at editing.modify (...) → trigger → onpointerup` (delete via UI gesture)

## Investigation (root mechanism)

`Devices.deleteEffectDevices` (`packages/studio/adapters/src/DeviceAdapter.ts:106-121`):
```ts
export const deleteEffectDevices = (devices: ReadonlyArray<EffectDeviceBoxAdapter>): void => {
    if (devices.length === 0) {return}
    assert(Arrays.satisfy(devices, (a, b) => a.deviceHost().address.equals(b.deviceHost().address)),
        "Devices are not connected to the same host")          // ← calls deviceHost() per device
    const device = devices[0]
    const targets = device.accepts === "audio"
        ? device.deviceHost().audioEffects.field()...           // ← deviceHost() again
        : ...
    ...
}
```

`deviceHost()` on each effect adapter resolves `this.#box.host.targetVertex.unwrap("no device-host")` (e.g. `DelayDeviceBoxAdapter.ts:58`, and the same line in every effect adapter under `packages/studio/adapters/src/devices/**`). When a device's `host` pointer field has **no target vertex**, the unwrap panics with `no device-host`.

**So one of the devices passed to `deleteEffectDevices` is not (or is no longer) connected to a host.** Reported once, via a pointer-up gesture (the device delete button / context-menu "Delete"), on a single build.

**Candidate triggers (unconfirmed — need repro / the project):**
- The effect was already detached from its host (stale UI element still firing delete), so its `host` pointer is empty.
- A migrated/partially-loaded project left an effect box in a chain view while its `host` edge was never resolved.
- A double-delete or delete racing with a host removal, leaving the effect orphaned at the moment delete runs.

Callers: `packages/app/studio/src/ui/devices/menu-items.ts:80` (per-device "Delete") and `packages/app/studio/src/ui/browse/PresetService.ts:217`.

## Recommended fix (no band-aid)

- In `deleteEffectDevices`, resolve each device's host via a **non-panicking** accessor and **drop devices whose host is absent** before the same-host `assert` and the index-reordering — an orphaned effect has no chain to renumber and can be deleted directly (`device.box.delete()`). This keeps the delete operation total instead of panicking the whole app over an already-detached device.
- Separately, investigate why a still-clickable effect can have an empty `host` pointer (UI not torn down on detach, or a load/migration gap) and fix at source if reproducible.

## Regression test

Adapter-level test: build a device chain, detach one effect's `host` pointer (or delete its host), then call `deleteEffectDevices([orphan])` and assert it neither throws nor corrupts the surviving chain's indices.
