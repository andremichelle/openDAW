# Plug-in Delay Compensation (#482, also #355, #357)

## Problem

A device that buffers before it renders (Compressor and Maximizer with look-ahead, 5 ms each) delays its own path,
and nothing delays the parallel paths to match. The track arrives late at every summing point. Measured in #482:
+240 frames at 48 kHz, gain and correlation unchanged. WCLAP plug-ins with their own latency and future FFT devices
(Werkstatt, #357) have the same shape.

Scope is the WASM engine (`crates/`). The TS engine (`core-processors`) is not touched.

## Best practice (research)

1. Every DAW with full PDC (Ardour 6+, Bitwig, Reaper, Live, Cubase) does the same thing at its core: each node
   reports its own latency, the host walks the graph in topological order and computes the latency at which each
   signal arrives, and at every point where signals MEET (bus inputs, parallel chains, sidechain inputs) the earlier
   inputs are delayed to the latest one. The master output ends up late by the worst path, uniformly.
2. Two ways to realise the alignment:
   1. Delay lines at junctions (Bitwig, Reaper, Ardour busses). Pure addition to the graph, costs memory per
      compensated input, works for live input too.
   2. Read-ahead (Ardour disk readers, Live offsets tracks): the timeline source of a latent track is read EARLIER
      by its latency, so nothing is delayed. Saves memory but every source (notes, audio regions, clips, automation,
      count-in) must accept a per-unit time offset. That is a refactor of the sequencer and is rejected here.
3. Live compensates automation and modulation too ("offsetting all tracks"), so automation behind a latent device
   lands on the audio it was drawn for. Tempo-synced LFOs inside devices after latency stay early (accepted there).
4. Sidechains: a look-ahead device is exactly a "negative delay" on its sidechain. A sidechain source that arrives
   earlier than the consumer's main input is delayed, one that arrives later cannot be fixed (Ardour: "no single
   correct answer" for parallel routes).
5. Feedback routes break PDC everywhere. Our graph is a DAG (`would_cycle`), so this does not apply.
6. CLAP: the host reads `clap_plugin_latency.get()` after `activate`, the plug-in may only change latency while
   deactivated, otherwise it calls `host->request_restart()` and the host recomputes its compensation graph.
   The `latency` word of `clap_audio_buffer_t` is the latency of that buffer's ports to the hardware, not the
   plug-in's latency, so writing 0 there is correct. The missing piece in #482 is reading the latency extension.
7. Recording and transport: the heard mix is late by the total PDC, so the playhead and recorded takes shift by it
   (Ardour aligns the disk writer to input, the clock shows what is heard).

## Design

The user's idea (collect latencies, topological pass, place delays) is the standard design. The refinement is
WHERE the delays go: not on plug-ins, but on the inputs of the nodes where paths meet. Then no new graph nodes,
no rewiring and no change to the topological sort are needed. The junctions own their delay lines.

```
own(n)      = latency the node itself reports (0 for almost every node)
arrival(n)  = own(n) + max(arrival(p)) over the DATA predecessors p of n
junction j  : delay(input i) = max(arrival(inputs of j)) - arrival(i)
```

Junctions in the engine today:

1. `AudioBusProcessor` sources: unit outputs into a bus or the master, aux sends, `AudioSinkProcessor` taps,
   Playfield / composite instrument slot sums, the effect composite wet sum.
2. `DryWetMixProcessor` in effect composites: the dry tap against the wet sum.
3. Sidechain ports: the source buffer against the consumer's main input arrival (delay only when it is earlier).
4. The metronome, mixed after the master: delayed by `arrival(master)` so the click matches the heard music.

A project without latent devices computes zero everywhere, holds no delay line and renders bit-identical.

## Status (2026-10-20)

1. Done: phases 0, 1, 2, 3, 4 (metronome, recording placement, MIDI out, offline trim, stems, freeze via stems), 6.
2. Sidechains are fully aligned, not only the earlier case: a late sidechain delays the consumer's main input
   and the paths downstream compensate. A sidechain from downstream (feedback) stays unaligned.
3. Open: phase 5 (automation, later), phase 7 (monitoring), the playhead (it subtracts no latency today either),
   a WCLAP plug-in with `clap.latency` is untested against a real bundle.

## Phases

### Phase 0: signal graph page

1. A new studio page (like the Graph page, the project stays loaded in the background) that draws the engine's
   live signal graph instead of the box graph.
2. Engine export next to `profile_report`: every node (id, label, reported latency, arrival) and every edge
   (source, target, data or ordering-only, compensation delay on that edge).
3. Processors are labelled with their name and reported latency, compensation delays are drawn on the edges.
4. Before Phase 1 every latency reads 0. The page doubles as the audit of every `register_edge` site (Phase 3.1).

### Phase 1: report latency

1. ABI: new host import `host_set_latency(frames: u32)`, callable from `init` and `parameter_changed`.
   `device_register` keeps its signature. WASM CONTRACT marker in `abi` and `engine/src/lib.rs`.
2. Engine: per device binding a `Cell<u32>` latency, set through the import (via `CURRENT_DEVICE_UUID`).
   A change marks `latency_dirty` on the engine.
3. `Processor` gets `fn latency(&self) -> u32 { 0 }` (default keeps every node at 0). `PluginAudioEffect`,
   `PluginInstrument` return the device cell.
4. Compressor and Maximizer report `look_ahead_frames` when look-ahead is on, 0 when off.
5. Inventory the remaining stock devices with a measured impulse test each (Autotune / PSOLA `2 * MAX_PERIOD`,
   oversampling in Waveshaper / Crusher via `dsp::resampler`, Vocoder, Pitch, Neural Amp). Report what is measured.
   Convolver is zero latency by design.

Measured (impulse onset and cross-correlation, defaults, 48 kHz):

1. Compressor and Maximizer look-ahead: 240, reported, equals the measured onset shift.
2. Fold oversampling (`dsp::resampler`, the only user): 15 / 23 / 26 frames for 2x / 4x / 8x, reported per factor.
3. Autotune: PSOLA reads 1280 frames (`2 * MAX_PERIOD`) behind, reported. The envelope lags about half a pitch
   period less (1197 at C4), the nearest-mark grain selection takes that back. Pitch-dependent, not compensable.
4. Zero: Convolver, Crusher, Dattorro Reverb, Delay, Gate, Revamp, Reverb, Stereo Tool, Tidal, Waveshaper.
   Vocoder needs a carrier and Neural Amp a model, both not measured yet.

### Phase 2: junction delays

1. `engine-env/compensation_delay.rs`: stereo ring buffer, length set outside render. Buffers are sized in
   reconcile, never in `process` (allocator rule). A length change crossfades old and new read taps over the
   same window the Compressor uses for its toggle, so a latency change does not click.
2. `AudioBusProcessor::add_audio_source(buffer, node)`: every source carries its producing `NodeId`, the bus
   holds an `Option<CompensationDelay>` per source and sums through it. Every call site moves (routing.rs,
   composite.rs, effect_composite.rs, wiring.rs).
3. `DryWetMixProcessor`: optional dry delay.
4. `SidechainPort`: optional delay on the resolved source buffer.

### Phase 3: the compensation pass

1. `EngineContext` distinguishes data edges from ordering-only edges. Audit every `register_edge` site (about 30)
   and register sidechain edges with a new `register_order_edge`, so a sidechain never raises the consumer's arrival.
2. `Engine::compensate_latencies()` runs after reconcile, `resolve_outputs`, `resolve_sends`, `resolve_sinks`,
   `resolve_sidechains`, and whenever `latency_dirty` is set. It walks the existing topological order once, fills
   `arrival` per node and hands each junction its per-input delays. Cost is linear in nodes and only runs on change.
3. Disabled devices are bypassed by the wiring already, so their latency drops out with no extra code.
   Mute and solo do not change compensation (static, like every DAW).
4. Engine exports `arrival(master)` as total PDC frames in the engine state for the main thread.

### Phase 4: timeline alignment

1. Playhead and position display subtract total PDC, exactly like `outputLatency` today.
2. Recording: `RecordAudio` and `RecordMidi` add total PDC to the take offset (the player heard the mix that late).
   Coordinate with `plans/capture.md` so PDC is one more term of the single latency model there.
3. MIDI output: events delayed by total PDC so external gear stays on the heard grid (#355 side).
4. Offline render (mixdown, `renderSection`, stems): render `total` extra frames and drop the first `total`.
   Stem taps sit BEFORE the bus junctions, so each stem is delayed by `total - arrival(tap)` first.
5. Freeze (`frozen.rs`): the frozen buffer is trimmed by the unit's own chain latency, a frozen unit reports 0.

### Phase 5: automation alignment

1. Parameter automation and modulation of a node are evaluated at `position - arrival(input of node)` (converted
   through the tempo map), so automation behind a latent device lands on its audio. Channel strips and sends
   included. Only nodes with non-zero upstream arrival change, zero-latency projects stay bit-identical.

### Phase 6: hosted and scripted latency

1. WCLAP: query `clap.latency` after `activate`, forward through the device's `host_set_latency`. Handle
   `host_latency.changed()` and `request_restart()` (deactivate, re-query, reactivate) on the main side.
2. Werkstatt / Apparat (#357): a script sets `this.latency = frames`, the script bridge forwards it.

### Phase 7: monitoring (later, opt-in)

1. A unit with live input monitoring hears its input through compensation as well. Offer "reduced latency while
   monitoring" (Live) that bypasses compensation for monitored units. Opt-in preference.

## Tests

1. Engine whitebox (`audio_unit/tests.rs`): impulse on two tracks, one with Compressor look-ahead, aligned at the
   master. Same for: bus into bus, aux send into a return, sink, effect composite with one latent entry against dry,
   Playfield slot, sidechain earlier (aligned) and later (unchanged), look-ahead toggled at runtime, disabled device.
2. Every existing test passes unedited (zero-latency projects are bit-identical).
3. The #482 repro run headless through the core-wasm node harness: lag 0 for every row.
4. Offline render and stems: impulse onset at the exact frame, length unchanged.

## Decisions

1. A compensation delay is capped at `MAX_COMPENSATION_SECONDS` (0.1 s), one constant in `engine-env`. Reaching it
   is reported on the signal graph page and in the console.
2. Phase 5 (automation) comes after the first release.
3. No PDC on/off switch.
