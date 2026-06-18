# Build order (feature dependency graph)

A topological order for the engine work. Each feature lists what it depends on; build the
least-dependent first and walk up. Tiers are layers of the graph: nothing in a tier depends on a
later tier. Within a tier, items are largely independent and can be done in any order or in parallel.

Important: after Tier 1 the graph splits into **two parallel branches** that only merge at devices:
- **Branch A (timeline / evaluation):** value events, tempo, signature, automation. No audio.
- **Branch B (audio spine):** processor graph, mixing, note flow, assets, sample playback.

Devices (Tier 5) need BOTH branches; arrangement/session (Tier 6) sits on top of devices.

Status: `[done]` `[partial]` `[todo]`. Read `← x, y` as "depends on x and y".

---

## Tier 0 — Foundations  (the base; nothing below them)
- Box graph: load + serialize + live sync (SyncSource) + checksum (debug/test-only, not production) + subscriptions. `[done]`
- PPQN math: pulses, conversions to seconds/samples. `[done]`
- Allocator: talc, reclaiming + grow. `[done]`
- Transport core: position, play/stop/seek, 128-sample block descriptor. `[partial: fixed bpm, no events]`
- Render scaffold: per-quantum render + output buffer. `[partial: metronome only]`

## Tier 1 — Evaluation & timing primitives  (pure data/time, no audio graph)
- ValueEvent model + interpolation (hold / linear / curve+slope) + `valueAt(pos)`.  ← PPQN, box graph
- Event collections + range query (sorted events, with looping).  ← ValueEvent / NoteEvent
- LoopableRegion math (global↔local position, loop cycles in a range).  ← PPQN, region boxes
- Update clock (automation grid, ~1/48-bar tick).  ← PPQN, transport
- Sub-block splitting (split a 128-block at event / grid positions).  ← transport block loop, event positions
- Parameter ramp / one-pole smoothing (declick DSP).  ← render quantum

---

## Branch A — Timeline & automation  (needs Tier 1 only)

### Tier 2A
- Tempo automation (varying tempo map; per-block bpm change).  ← ValueEvent eval, update clock, sub-block split
- Signature track (nom/denom changes, bar grid).  ← event collection, PPQN
- Loop area (wrap + discontinuity) + marker track (jumps, play counts).  ← transport, sub-block split
- Count-in.  ← transport, signature
- AutomatableParameter (mapping linear/exp/dB/bipolar, target track, touch).  ← box-graph fields, ValueEvent
- Automation application (value lane → parameter, smoothed).  ← AutomatableParameter, update clock, ramps

> Your example: tempo automation lives here because it cannot exist before ValueEvent + evaluation (Tier 1).

## Branch B — Audio spine, note flow, assets  (needs Tier 1; independent of Branch A)

### Tier 2B — signal graph & mixing  (the engine spine)
- Processor abstraction + audio-unit model (instrument / audio / bus / output).  ← box-graph unit + device boxes
- Signal graph: DAG + cached topological sort + wiring (rewire at phase.before).  ← processor model, box-graph connections, subscriptions
- Channel strip: volume / pan / mute / solo (all ramped).  ← processor, ramps
- Buses + summing + aux sends (pre/post, gain, pan).  ← signal graph, channel strip
- Mono / stereo up/down-mix.  ← channel strip
- Master output mix → worklet output.  ← buses
- Output-buffer registry (metering taps).  ← signal graph
- (Channel-strip params become automatable once Branch A lands; static values work first.)

### Tier 3B — note flow & assets  (inputs instruments consume)
- NoteEvent + lifecycle (on/off, sorted, stop-before-start).  ← event collection
- Note / audio / value region querying over a range (with looping).  ← event collections, LoopableRegion
- Note sequencer + voice allocation/stealing + glide/legato + EventSpanRetainer.  ← note lifecycle, region query, transport
- Note broadcaster, audition notes, tuning (A4 / cents).  ← note flow
- AudioData / SAB asset model + worklet delivery.  ← shared-memory switch (SAB)
- Sample playback (read head, interp, rate, loop, ADSR, resampler, voice fade).  ← AudioData
- Soundfont playback (SF2 parse, zone selection, per-voice).  ← AudioData, voice management

---

## Tier 5 — Devices  (the branches MERGE here)
- Device-chain hosting (enable / bypass / order, sidechain).  ← signal graph (B), parameters (A)
- Instruments: Tape ← sample playback; Soundfont ← SF2; synths (Vaporisateur / Nano / Apparat / Playfield) ← osc/filter/ADSR + note flow + params.  ← Tier 2B + Tier 3B + Branch A
- Audio effects (~19).  ← signal graph, parameters, audio I/O
- MIDI effects (Arpeggio / Pitch / Velocity / …).  ← note flow
- Unknown-device fallback.

> Your example: devices sit here because they need the whole audio graph (B) + timeline/automation (A) + note/asset flow.

## Tier 6 — Arrangement, session, external I/O  (top of the graph)
- Timeline regions driving playback (audio / note / value regions on tracks).  ← regions, note flow, sample playback, devices
- Clips / launcher + clip sequencing (schedule at quantized boundary).  ← regions, transport scheduling
- Recording & monitoring (capture, lock-free ring buffer).  ← signal graph, ring buffer
- External MIDI I/O (sender, transport clock).  ← note flow, transport clock
- Modular system.  ← signal graph, parameters
- Grooves / swing.  ← note timing

## Cross-cutting (build alongside, as the consumer appears)
- Telemetry, fixed state channel (position / bpm / flags via SyncStream).  ← transport state.  *Cheap; can land early.*
- Telemetry, dynamic peaks + RMS.  ← output-buffer registry (Tier 2B)
- Telemetry, spectrum (FFT) + waveform.  ← output + an FFT primitive
- Real-time rules applied throughout: ramps, NaN/denormal, topo-sort cache, seeded RNG, zero-alloc render.

---

## Critical path (longest chain to "plays a real arrangement")
PPQN → ValueEvent + evaluation → (Branch A automation) and (Branch B signal graph + mixing → note flow + sample/soundfont) → devices → regions + clip sequencing.

## Suggested walk (least-dependent first)
1. **ValueEvent + evaluation** (Tier 1). Most-depended-on primitive; unlocks all of Branch A.
2. **Signal graph + channel strip + master mix** (Tier 2B). Unlocks "audio actually flows" with even a trivial generator, and the peaks back-channel.
3. Then climb both branches in parallel: timeline/automation (A) and note flow + sample playback (B).
4. **One instrument end to end** (e.g. Tape, since it only needs sample playback + note flow) once 2B + 3B exist.
5. Devices in bulk (Tier 5), then arrangement/clips (Tier 6).

## Where we are
Tier 0 done (transport/render are the fixed-bpm subset). The metronome was a vertical slice that
touched transport + a trivial generator + output. Next least-dependent step is **Tier 1 ValueEvent +
evaluation**, then pick a branch: Branch A (timeline) or Branch B (the signal-graph spine). Devices
are deliberately last.
