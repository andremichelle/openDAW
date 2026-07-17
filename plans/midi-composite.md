# Midi Composite — parked (2026-07-17)

A parallel MIDI stack (`MidiCompositeBox`): several midi-effect chains run in parallel on the incoming note
stream, their outputs merged and sent on. The note-side mirror of the AudioComposite. It was implemented,
found to be fundamentally broken, and has been REMOVED from the tree. This document is why, so a future
attempt starts from the real constraints instead of rediscovering them.

## Why it cannot work the way it was built

The implementation used a `NoteTee` + `NoteMerge`: pull the upstream ONCE per window, cache the events, replay
them to every branch, then merge the branch outputs. That is wrong at the foundation, for two independent
reasons:

1. The note source is DESTRUCTIVELY STATEFUL. `NoteSequencer::process_notes` (engine-env) calls
   `retainer.drain_linear_completed(...)`, which REMOVES held notes as it reads. It can be pulled EXACTLY ONCE
   per block. A second pull sees a drained retainer and returns wrong results. So a shared upstream genuinely
   cannot be pulled once per branch.

2. Branches DO NOT request the same window. A `Zeitgeist` (groove / shuffle) inside a branch WARPS the pull
   window — it pulls its upstream at a shifted `(from, to)` and re-times the events. So branch A (with a
   Zeitgeist) asks the shared upstream for a different window than branch B. A tee that caches by
   `(from, to, flags)` cannot serve that: it either misses and re-pulls the destructive source, or replays the
   wrong window. "Pull once per window" is incompatible with per-branch time-warping.

The audio composite does NOT have this problem: each audio ENTRY is a buffer chain, and buffers are read
non-destructively any number of times. Notes are a PULL chain, not buffers — the whole model differs.

## The design the future implementation needs

Each entry's fx chain MUST pull the note source INDIVIDUALLY (the user's requirement), so a per-branch
Zeitgeist warps only its own pull. The open question is TOPOLOGY:

- Option A — a MidiComposite is rooted directly on the note source. Then each entry gets its OWN
  `NoteSequencer` instance over the same tracks (exactly how audio CELLS each own a sequencer, sharing the
  `clip_sequencer` replay cache). Each branch pulls its own sequencer, once per block, Zeitgeist-safe. Simple
  and correct — but it constrains the MC to sit on the source (no arp etc. BEFORE it).

- Option B — a MidiComposite can sit anywhere mid-chain. Then each branch needs an INDEPENDENT COPY of the
  entire upstream sub-chain (a fresh stateful sequencer plus any prior midi fx, per branch), because a shared
  upstream cannot be pulled N times. Correct but a real rebuild — N copies of everything below the MC, kept in
  sync on every reconcile.

Decide the topology FIRST; it dictates everything else.

## The note-ID collision (either topology)

Each `NoteSequencer` counts note ids from 0 (`self.next_id`). N independent sequencers therefore emit COLLIDING
ids. Merged into one downstream, a note-off from one branch would match (and release) a same-id voice from
another branch — a delayed note in a Zeitgeist branch gets cut short by a plain branch's earlier note-off.

Fix: namespace ids by branch index. Both the note-on and the note-off of a branch get the SAME branch offset
(e.g. `id | (branch_index << HIGH_BITS)` on the u32 `EventRecord.id`), so they still match WITHIN a branch and
never collide ACROSS branches. This part is well understood; it just was not reached.

## Concrete bugs observed while it was live (all symptoms of the above)

- Empty MC semantics were wrong. It was made an identity pass-through (mirroring the empty AUDIO composite).
  The user's model: an empty MC has no branch to route notes through, so it should DROP note starts and PASS
  note releases (the `SlotRoute` gate rule — "releases + chokes still pass"), releasing held voices and letting
  no new notes reach the instrument. Never resolved because the pull model itself was wrong.
- Stuck notes when deleting an entry. Never root-caused. The duplicate-id theory was disproved (the
  polyphonic voice `stop(note_id)` releases ALL matching voices, so a plain id collision does not strand a
  voice) — but timing-warped branches with colliding ids DO (a branch's note-off releases another branch's
  still-sounding voice). Ties back to the ID-namespacing gap.
- The instrument's note indicator went dark once an MC was in the chain, though notes clearly played. The
  engine `note_bits` marking through the tee/merge path was verified in isolation (a direct
  `pull_events_into` test marked the bit), so the cause is elsewhere in the real chain — never found. NOTE:
  native tests CANNOT exercise this (the stub device is a no-op, so it never calls `host_pull_events` where
  marking happens); it needs the real wasm engine.

## Real fixes that WERE made (kept as knowledge, code removed)

- Merge ordering must mirror the engine's `compare_lifecycle`: at an equal position, note-OFF (and CHOKE)
  before note-ON, so a re-trigger stops the old voice before starting the new one. Sorting on position alone
  let a note-on precede its note-off and the instrument killed the voice it just started.
- `pull_events_into`'s Tee/Merge arms had to clear `note_bits` during the internal branch pulls and let only
  the outer arm mark once from the merged output — the same discipline the `MidiFx` arm already follows.
- Tests that pull through the global `PULL` context MUST take a crate-wide lock; parallel test threads racing
  on `PULL` segfault. `crate::pull_lock()` now exists for this and is kept (the audio path uses it too).

## What was removed

The `MidiCompositeBox` / `MidiCompositeCellBox` schemas + `Pointers.MidiCompositeCell`, their adapters, the
`MidiComposite` effect factory + editor, the engine `midi_composite.rs`, `MidiCompositeBinding`, the
`PullLink::Tee` / `PullLink::Merge` variants, `ProcHandle::MidiComposite`, and the midi-composite build / fold
routing. The AudioComposite is unaffected and remains.

`EFFECT_COMPOSITES` / `EffectCompositeSpec` / the `effect_composite_register` ABI KEPT their generic (audio +
midi) shape — the seam is fine and re-adding the midi kind later is a registration, not an engine change.
