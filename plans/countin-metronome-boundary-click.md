# Count-in metronome: sample-accurate click ceiling (#367)

**Type:** bug fix (WASM engine regression vs the old TS engine)
**Scope:** small — one field + setter on `Metronome`, one clamp in `Metronome::process`, one line in the engine's per-quantum setup.
**Assisted:** Claude Code. Root cause was pinned by the reporter (naomiaro, #367); verified against the engine source before editing.

## Symptom

With the metronome preference **disabled** and a count-in enabled, starting a recording can play one extra
click exactly at the punch-in downbeat: a 1-bar 4/4 count-in sounds as **1 2 3 4 — 1** instead of **1 2 3 4**.
The old TS engine was correct; the regression window is the TS→WASM engine transition. Audibility is
alignment-dependent (always leaks at 44.1 kHz / 120 BPM; some 48 kHz configs mask it).

## Root cause (`crates/engine/src/lib.rs`, `crates/engine/src/metronome.rs`)

1. The metronome is forced on during count-in regardless of the preference (`apply_metronome`:
   `enabled = metronome_pref || is_counting_in`).
2. The count-in → recording flip is **quantum-granular** — it tests the block *start* position:
   `if self.is_counting_in && self.transport.position() >= self.recording_start { … set_enabled(pref) }`.
3. When `recording_start` falls **strictly inside** a quantum, the flip has not fired for that block, the
   metronome is still forced on, and `Metronome::process` schedules every beat in `[p0, p1)` — including the
   punch-in downbeat at exactly `recording_start`. The flip then lands on the *next* quantum.

The TS engine split the render block at `recording_start`, so the boundary beat fell in the post-flip half
and was suppressed when the preference was off. The WASM engine processes the whole quantum with the
metronome state fixed at block start, so the boundary click leaks.

## Fix

Give the metronome a sample-accurate **exclusive click ceiling** — the pulse beyond which no click
schedules — reproducing what the TS block split achieved without splitting the block:

- `Metronome`: new `click_ceiling: f64` (default `f64::INFINITY`) + `set_click_ceiling(pulse)`. In
  `process`, `region_end` is clamped to `min(region_end, click_ceiling)`, so the `while position <
  region_end` loop never schedules a beat at or past the ceiling.
- Engine per-quantum (right after the count-in flip): set the ceiling to `recording_start` while the
  metronome is forced on **only** for the count-in (`is_counting_in && !metronome_pref`), else
  `f64::INFINITY`. A preference-driven metronome stays unbounded and plays through the punch-in, unchanged.

The count-in beats (all strictly before `recording_start`) are untouched; only the boundary downbeat — the
first *recorded* beat, not a count-in beat — is suppressed when the metronome is off.

## Tests (`crates/engine/src/metronome.rs`, native `cargo test`)

- `count_in_click_ceiling_suppresses_the_punch_in_downbeat` — a block straddling the recording_start pulse
  (`p0 < recording_start < p1`, the mid-quantum case): the boundary downbeat sounds with no ceiling and is
  silent with the ceiling set. **Proven RED→GREEN**: removing the clamp fails exactly this test.
- `count_in_click_ceiling_keeps_the_count_in_beats` — a count-in beat strictly below the ceiling still
  sounds, so the ceiling cuts only at/after `recording_start`.

## Verification

- `cargo test -p engine`: **181 passed** (179 existing + 2 new).
- `cargo build -p engine --target wasm32-unknown-unknown`: compiles clean (no_std real target).
- No new clippy warnings in the changed files.
