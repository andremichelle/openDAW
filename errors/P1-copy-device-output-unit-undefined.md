# Copy-device shortcut — copies[0] undefined (Output unit)

- **status:** FIXED (code shipped + regression test; server `fixed=1` pending deploy/verification) · **priority:** P1
- **occurrences:** 3 · **ids:** [1016, 1017, 1018]
- **assessment:** The global `copy-device` keyboard shortcut calls `TransferAudioUnits.transfer([...])` and then unconditionally reads `copies[0].editing`. When the currently edited audio-unit is the **Output** unit, `transfer` deliberately returns `[]` (it refuses to duplicate the Output singleton — the #1005-1010 fix), so `copies[0]` is `undefined` → `Cannot read properties of undefined (reading 'editing')`.
- **action (done):** `StudioShortcutManager.ts` copy-device handler now early-returns when the edited unit `isOutput`, and both call sites (`StudioShortcutManager.ts`, `TrackHeaderMenu.ts`) read the result via `Option.wrap(copies.at(0)).ifSome(...)` instead of `copies[0]`. Regression test added to `DuplicateUnitGraftsRoot.test.ts` (#1016-1018) — passes.

[< back to index](error-triage.md)

## Reports

### Error: TypeError: Cannot read properties of undefined (reading 'editing')
- **occurrences:** 3 · **ids:** [1016, 1017, 1018] · **span:** 2026-06-25 · **builds:** 1 (6abdd11c) · **browsers:** Chrome/Win (1017, 1018), Firefox/Win (1016, `T[0] is undefined`)
- **stack (source-mapped):**
  - `at src/service/StudioShortcutManager.ts:155:68` → `userEditingManager.audioUnit.edit(copies[0].editing)`
  - `at StudioShortcutManager.ts:151:21` → `.ifSome(({box}) => {`
  - `at src/service/StudioService.ts:363` → `runIfProject` (`getValue().map(({project}) => procedure(project))`)
  - `at StudioShortcutManager.ts:149:66` → `gc.register(gs["copy-device"].shortcut, ...)`
  - `at lib/dom/shortcut-manager.ts` → keydown dispatch
  - `at src/boot.ts:119` → `Surface.subscribeKeyboard("keydown", ...)`

## Investigation (root cause confirmed)

**Trigger:** user presses the `copy-device` shortcut while the **Output** audio-unit's device chain is the one being edited (e.g. the Output channel strip is selected). The menu path (`TrackHeaderMenu.ts:73` "Duplicate AudioUnit") is guarded by `hidden: audioUnitBoxAdapter.isOutput`, so only the **keyboard shortcut** reaches the crash — consistent with all 3 reports coming through `StudioShortcutManager`.

**Mechanism:**
- `StudioShortcutManager.ts:149-156` resolves the edited unit, then:
  ```ts
  const copies = editing.modify(() => TransferAudioUnits
      .transfer([deviceHost.audioUnitBoxAdapter().box], skeleton), false).unwrap("copyUnit")
  userEditingManager.audioUnit.edit(copies[0].editing)   // ← copies[0] is undefined
  ```
- `TransferAudioUnits.transfer` (`packages/studio/adapters/src/transfer/TransferAudioUnits.ts:21-27`) filters out the Output unit and **returns `[]`** when nothing else remains:
  ```ts
  const sources = audioUnitBoxes.filter(box => box.type.getValue() !== AudioUnitType.Output)
  if (sources.length === 0) {return []}
  ```
  This `[]` is the *correct, intended* behaviour from the #1005-1010 fix (refusing to graft a second `RootBox`). The bug is that the **shortcut call site never anticipated an empty result.**

**Confirmed by existing test:** `packages/studio/core/src/project/DuplicateUnitGraftsRoot.test.ts` ("refuses to duplicate the Output unit … #1005-1010") asserts `transfer([outputBox]).length === 0`. So the empty return is contractual; the call sites must honour it.

**Second latent call site:** `TrackHeaderMenu.ts:83` does the same `copies[0].editing`. It is currently shielded by the `hidden: isOutput` menu flag, so it has not crashed — but it shares the unsafe access and should be hardened too (defence-in-depth).

## Recommended fix (no band-aid)

1. **Don't even attempt to duplicate the Output unit from the shortcut.** Mirror the menu's `hidden: isOutput` guard — early-return in the `copy-device` handler when `deviceHost.audioUnitBoxAdapter().isOutput` (or the box type is `AudioUnitType.Output`). This avoids opening an empty `editing.modify` transaction.
2. **Make both call sites tolerate an empty copy result.** Replace `copies[0].editing` with a safe access (e.g. `copies.at(0)` → `isDefined` check / `Option.wrap(copies.at(0)).ifSome(...)`), so any future "nothing was copied" outcome cannot null-deref. Both `StudioShortcutManager.ts:155` and `TrackHeaderMenu.ts:83`.

## Regression test

Extend `DuplicateUnitGraftsRoot.test.ts` (or add a service-level test) asserting that invoking the copy-device path on the Output unit performs no edit and does not throw.
