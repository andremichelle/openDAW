# Effect-device delete — "no device-host" unwrap

- **status:** FIXED (two root causes closed; code + tests; deploy pending — #1015's exact trigger unconfirmed, monitor) · **priority:** P2
- **occurrences:** 2 · **ids:** [1015, 1020]
- **assessment:** `Devices.deleteEffectDevices` ran on a device whose `host` pointer no longer resolves. Two independent root causes were found and fixed at their source; `deleteEffectDevices` itself was deliberately left untouched (adding orphan-tolerance there would mask whatever produces orphans).

[< back to index](error-triage.md)

## Reports

### Error: Error: no device-host
- **occurrences:** 2 · **ids:** [1015, 1020] · **span:** 2026-06-17 → 2026-07-02 · **builds:** 2 (6abdd11c, 169f7f25) · **browsers:** Chrome/ChromeOS, Chrome/Android (Fire tablet KFTUWI)
- **stack:** `unwrap("no device-host") → <EffectAdapter>.deviceHost → deleteEffectDevices → editing.modify → MenuItem trigger → onpointerup`

## Root cause A — ghost re-trigger of menu items on touch (proven, #1020)

#1020's log is unambiguous — the SAME menu item fired twice:

```
1783017702688 simulate pointerup onpointerdown   ← every tap in this session logs this
1783017702690 MenuItem.trigger "Delete 'Crusher'"
1783017704114 simulate pointerup onpointerdown
1783017704114 MenuItem.trigger "Delete 'Crusher'"  ← device already deleted → panic
```

`Surface.tsx#listen` works around missing outside-pointerup events by tracking the last `pointerdown` target and dispatching a **fabricated `pointerup` to the previous target** when a new `pointerdown` arrives while one is still tracked. It listened for `pointerup` but **not `pointercancel`** — yet per the Pointer Events spec a pointerdown concludes with either. On this tablet every tap ended in `pointercancel` (browser-owned touch gestures), so the tracking was stale on EVERY tap and each new tap re-activated the previously tapped element. Menu items trigger on pointerup → "Delete 'Crusher'" ran once per tap, the second time against an already-deleted device.

**Fix:** `Surface.tsx` now also clears the tracking on `pointercancel`.

**Open observation (separate issue, not fixed):** on devices where taps end in `pointercancel`, controls that activate on `pointerup` may not respond at all — the stale-dispatch bug was accidentally making them work "one tap late". If reports of unresponsive touch UI appear, this is where to look.

## Root cause B — aborted transactions restored boxes with unresolved pointers (proven by test)

`BoxGraph.abortTransaction` **discarded** the deferred pointer updates of boxes recreated during rollback (`DeleteUpdate.inverse` → `createBox` → pointer reads deferred) without ever calling `resolvedTo`. Result: a live, staged box whose `host` pointer has `targetAddress` set but `targetVertex = None` — visible in the UI, unresolvable on access. Fixed in `packages/lib/box/src/graph.ts` (abort now resolves recreation-deferred updates); regression test "restores deleted boxes with resolved pointers when a transaction aborts". See [[P2-undo-rollback-pointerfield-missing]] for the full abort-integrity fix set.

## #1015 specifics (trigger unconfirmed)

ChromeOS session: stock preset "Noise Gate" applied → `RangeError: Offset is outside the bounds of the DataView` warned during preset decode (aborted transaction) → 4s later "Delete 'Gate'" → panic. The abort + restore sequence matches root cause B's preconditions, and ChromeOS is a touch device (root cause A also plausible), but the log doesn't pin which path produced the orphan. The corrupt-preset RangeError itself (thrown from `PresetDecoder.insertEffectChain`'s unguarded header read, `PresetDecoder.ts:249`, when bytes are truncated) is worth its own hardening pass if it recurs.
