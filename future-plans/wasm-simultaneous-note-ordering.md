# WASM engine: deterministic ordering of simultaneous note events

## Problem

In the wasm engine, the order in which **simultaneous note events** (events sharing the same sample
offset and the same on/off kind, e.g. the notes of a chord, or notes that end at the same instant) are
delivered to a device is **unspecified**. The device SDK's dispatch sorts the per-quantum event scratch with
`sort_unstable_by` on `(offset, rank)` (`crates/abi/src/lib.rs`, `render_instrument`), so ties have no
defined order. Combined with the engine retainer releasing equal-end notes by ascending pitch
(`crates/processors/src/sequencer.rs` + `crates/value/src/retainer.rs`), a chord reaches the device in an
order that is neither defined nor guaranteed to match the TS engine.

This affects any device whose behaviour depends on event order, in particular **monophonic last-note
priority** and **glide-back** in `crates/voicing` (`MonophonicStrategy`): which note a mono voice plays, and
whether it glides back down the held stack on release.

## How it surfaced

Loading `project.od` (a monophonic Vaporisateur patch with glide) on the Load File page. The mono glide-back
fires correctly for **staggered** releases (the stabs, and the first chord glides 67 → 63 → 60 as its notes
end at different times). But the **final chord** (62/65/69) ends all three notes at the same instant: the
wasm releases them low → high, so the released note is only ever the stack "top" on the last one, and the
voice just releases at the top note (69) with no glide. The TS engine glides 69 → 65 → 62 there, i.e. it
processes that simultaneous release top-first.

Verified by replaying the project's exact notes through the real `NoteSequencer` → `MonophonicStrategy`: the
glide-back logic is a faithful port (staggered cases match TS exactly); the divergence is purely this tie
ordering, not the strategy.

## Repro files

- `packages/app/wasm/public/project.od` — where it first surfaced (the Load File page).
- `packages/app/wasm/public/vapo-release-issue.od` — a focused case for A/B comparing wasm vs TS: load it in
  both engines and compare the release of the simultaneous-ending chord.

Note: the wasm's "release at the top note" is arguably the more correct musical result (no phantom downward
portamento through notes that all ended together), so this is a behavioural-parity question, not a clear bug.

## Proposed resolution

Make simultaneous-note ordering deterministic and TS-matching:

- Use a **stable** sort (`sort_by`, not `sort_unstable_by`) in the device dispatch so the engine's pull order
  is preserved through `(offset, rank)` ties.
- Add a defined **tie-break** (e.g. by pitch) so a chord's note priority / glide is consistent and matches
  the TS engine, rather than relying on retainer insertion order.
- Decide the intended parity: match TS (glide back on simultaneous release) or keep the wasm's release-at-top
  behaviour deliberately. Confirm against the TS `EventSpanRetainer` / `NoteEventInstrument` ordering before
  locking it in.

## Affected files

- `crates/abi/src/lib.rs` — `render_instrument` dispatch sort.
- `crates/processors/src/sequencer.rs`, `crates/value/src/retainer.rs` — retainer release order.
- `crates/voicing/src/lib.rs` — `MonophonicStrategy` (consumer; logic itself is correct).
