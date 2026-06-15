# 09 — Rollout, fallback, retirement

## Coexistence is cheap (by design)

Both engines read the same **read-only box graph** and speak the same **engine control/state
protocol** (`04`). The UI is engine-agnostic → the engine is swappable behind a flag. **The TS engine
stays the default and the fallback** for the entire port.

## Flag

A selector under experimental/beta preferences: **TS (default) | WASM**. Internal/dev first.

## Phased exposure

1. **Dev-only** while WASM is partial.
2. **Capability gating** — the WASM engine declares which features/devices it supports; a project
   using anything unsupported **auto-falls-back to TS**. Lets WASM ship for simple projects *before*
   full parity (early real-world signal).
3. **Beta opt-in → % rollout → default WASM**, once parity + stability hold across the device matrix.

## Safety / fallback

- **Auto-fallback on failure:** WASM panic / NaN / sustained underrun → drop to TS for the session +
  report. The engine boundary makes this a clean swap (reload project into TS).
- **Shadow mode (optional debug):** render WASM alongside TS on real projects and compare (the parity
  harness, live); only TS is audible. Catches divergence in the wild. ~2× CPU → opt-in/debug only.
- **No hot-swap while playing:** switching engines requires stop + reload, handing over the transport
  position.

## Retirement

- Flip the default to WASM **only after** sustained production stability + full device-matrix parity.
- Keep TS as fallback for a grace period, then remove the TS engine (large deletion) — **not before**
  WASM is proven everywhere.
- **TS adapters stay regardless** — they serve the UI.

## Open

- Capability-gating granularity (per-device? per-mechanic?).
- Whether shadow mode is worth building.
- Flip-the-default criteria (parity coverage %, crash rate, perf headroom).
