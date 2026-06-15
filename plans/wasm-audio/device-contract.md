# Device contract (UI ↔ engine)

A device is split: **UI in TS** (main thread), **DSP in Rust** (worklet). The contract between them
is the top bug risk. Governing rule: **zero hand-synced state across the boundary** — ids, ranges,
mappings, telemetry slots and buffer offsets come from **one declaration per concern**, and a
per-device contract test fails the build if the two sides disagree.

## Inbound (UI → DSP): parameters — mostly already solved

- Parameters are **box fields**, read on the Rust side via the generic box-graph codec (see
  `04`) — same ids/keys, ranges, defaults by construction. No per-device generation.
- **The one trap: value mapping.** Normalized 0..1 ↔ real value (linear / exp / dB / bipolar) is
  *behavioral*, not in the box format. Automation stores normalized; UI shows real; DSP uses real. If
  TS and Rust each implement the curve independently, they drift. → define each mapping **once**,
  mirror it in Rust, and **parity-test the curves**.
- Automation (value events) and structural data ride the box graph — same shared model.

## Outbound (DSP → UI): telemetry — the risky channel

- Meters, gain-reduction, scopes, spectrum, note activity. **Not in the box schema today** — flows
  over the live-stream by hand-assigned addresses = silent-desync territory.
- Fix: make it first-class. Each device **declares its telemetry outputs** (id + type); codegen emits
  the **Rust writer** and the **TS reader** + the shared buffer layout. Nothing hand-assigned.

## Commands / actions

- Most "actions" are box mutations (load model = set a pointer, etc.) → already covered by the box
  graph. Truly transient commands (e.g. MIDI panic) use a small **generated typed command enum**, not
  ad-hoc messages.

## Where each piece lives

- **Params** → box fields; Rust reads them via the generic codec. No duplication.
- **Value mappings** → defined once, mirrored in Rust, parity-tested.
- **Telemetry outputs** → one manifest per device → TS reader + Rust writer + shared buffer layout.
- **Transient commands** → one shared typed enum.

These last three are tiny per-device definitions, not a full generator.

## Verification

- **Contract test per device**: param set, mappings, telemetry set, command enum must match across
  TS and Rust (round-trip / golden). Build fails on mismatch.
- Plugs into the parity harness (test docs): same device, same input → same audio + same telemetry.
