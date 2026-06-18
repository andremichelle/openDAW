# Audio Engine — Feature Inventory

The complete list of engine **mechanics** to re-implement, derived from the current TS engine
(`core-processors`, `lib/dsp`, `boxes`, `adapters`, asset layer). This is the WHAT, not the how —
no solutions here. Individual device DSP is **not** specified here (only the chain/parameter plumbing);
the concrete device types are listed in the appendix for scope. We will order this easiest-first and
implement one item at a time.

Out of scope (decided): multi-threading, offline render / export / bounce.

---

## 1. Time & transport
- PPQN model (960 pulses per quarter); musical position as integer pulses; bar/beat derivation.
- ppqn ↔ samples conversion (depends on bpm + sampleRate).
- Transport: play, stop, pause/resume (remembers position), seek / set position.
- Fixed tempo (bpm) + **tempo automation** (varying tempo map); per-block bpm-change detection.
- Time signature + **signature track** (nom/denom changes); bar grid; floor/ceil/round-to-bar; bar length at position.
- Loop area (enabled, from, to): wrap playhead at end + discontinuity; optional pause-instead-of-loop.
- Marker track: markers with play counts (0 = infinite); jump-back-to-previous-marker.
- Count-in (N bars), isCountingIn, countInBeatsRemaining, recording-start callback.
- Discontinuity/leap signaling (seek/loop/marker/transport change) → processors reset read heads & voices.
- Update clock: periodic update events on a musical grid (~1/48 bar) driving automation polling.
- Sample-accurate scheduling: split a block at the musical grid + event positions into sub-blocks.

## 2. Signal graph & routing
- Processor graph (DAG); topological sort, recomputed on graph change.
- Audio-unit types: instrument, audio, bus, output/master.
- Per-unit chain order: MIDI effects → instrument/input → audio effects → channel strip → output.
- Buses sum multiple inputs; aux sends (pre/post, send gain, send pan) to aux buses.
- Mono↔stereo up/down-mix; channel-count handling.
- **Variable channel count (deferred):** the Rust `AudioBuffer` is fixed stereo for now, matching the TS engine (mono/stereo only) and the stereo worklet output. Generalize to N channels (quad, 5.1, 3D / ambisonics) only when a device or output target actually needs it. It is a self-contained buffer refactor that stays off the hot path until then, so there is no benefit to building it speculatively.
- Wiring invalidation + re-wire at process-phase "before"; cleanup at "after".

## 3. Channel strip & mixing
- Volume (dB→linear, ramped ~5 ms); pan (linear or equal-power law).
- 2×2 stereo matrix (gain, pan, width, invert, swap) — ramped per sample.
- Mute (ramped); Solo + **virtual solo** (mutes upstream non-soloed units); mixer solo-state tracking.
- Input summing / mixdown.

## 4. Block / quantum processing
- 128-sample render quantum.
- Block descriptor: index, p0/p1 (ppqn), s0/s1 (sample offsets), bpm, flags (transporting/playing/discontinuous/bpmChanged).
  - Planned: replace the `BlockFlags` integer bitset with actual booleans (one field per flag) instead of bit-packing.
- Sub-block splitting at events (tempo change, loop, marker, callbacks, MIDI/automation events).
- Process phases (before / after).
- NaN sanity checks; denormal handling.

## 5. Regions (arrangement)
- Base region: position, duration, mute, label, hue, complete / resolveDuration.
- **LoopableRegion**: loopOffset + loopDuration → repeating cycles; global↔local position mapping; locate loop cycles in a range.
- Note region: holds note-event collection + eventOffset.
- Value region: holds value-event collection; valueAt(pos), incoming/outgoing value.
- Audio region: file ref, timeBase (musical/seconds), waveformOffset, gain, fades, pitch-stretch, time-stretch, start/end markers, play mode.
- Fade envelope (in/out durations + curve slopes); per-block crossfade gain buffer.
- Content collections: shared, copy, flatten, consolidate.

## 6. Clips (session / launcher)
- Base clip: index, duration, trigger mode (loop, reverse, speed, quantise, trigger).
- Audio / note / value clips (mirror regions, launcher-based).
- Clip sequencing: per-track state (waiting / playing / stop-scheduled); schedule play/stop at a quantized boundary; iterate "sections" (clip + time span) over a range.

## 7. Note flow
- Note event: position, duration, pitch (0–127), velocity, cent, chance %, playCount, playCurve.
- Note-repeat feature (count, curve, length).
- Note lifecycle: note-on/off events, sorted (stops before starts at equal position).
- Query notes over a time range from region/clip collections (with looping).
- Voice allocation: monophonic / polyphonic; voice stealing (oldest); max-voice limit.
- Glide / portamento (linear or exp frequency ramp).
- Gate / legato tracking; auditioned (preview) notes.
- MIDI input handling; chance/probability gating; note broadcaster (UI).
- Tuning: base frequency / A4 (default 440), cent offset, pitch→frequency.

## 8. Automation / value flow
- Value event: position, value, interpolation (hold / linear / curve+slope).
- Interpolation between events (slope curve); valueAt(pos) query.
- Block-rate parameter application via update events; parameter smoothing ramp (~5 ms) to declick.
- Automatable parameter: value mapping (linear/exp/dB/bipolar), unit & print mapping, reset/anchor, automation target track, touch state (write/latch).
- Automation sources: track value lane (ValueRegion), clip automation, tempo automation, signature automation, MIDI control source, modulation.
- Parameter registry by address; write notifications.

## 9. Sample playback
- AudioData (channels, sampleRate, frames in SharedArrayBuffer).
- Read head with linear interpolation; playback-rate ratio (sample-rate vs engine-rate × pitch).
- Pitch shift via rate; loop modes (off / continuous / loop with start-end).
- Per-voice ADSR (attack/release) envelope.
- Time-stretch: warp markers (ppqn↔seconds), transient markers, tempo-aware stretch, stretch voice fading.
- Resampler (2× halfband polyphase).
- Voice fade (~5 ms) on kill/discontinuity; tape voice states (direct / once / repeat / ping-pong).
- Frozen playback (pre-rendered audio, bypasses chain).

## 10. Soundfont playback
- SF2 parse (presets / instruments / zones / generators / samples).
- Preset selection; zone matching by key range + velocity range.
- Sample lookup (Int16 PCM); root key (override generator or sample header); tuning.
- Per-voice pitch rate, ADSR, pan, loop mode (off / continuous / loop-until-release); note→voice mapping.

## 11. Asset management (samples & soundfonts)
- AudioData in SharedArrayBuffer; sample metadata (name, bpm, duration, sampleRate, origin).
- Import/decode (WAV 16/24/32 + WebAudio fallback); bpm estimate; UUID keys (sha-256).
- Storage in OPFS (audio.wav + peaks.bin + meta.json); soundfont storage (sf2 + meta).
- Online APIs (list / load / upload); AssetLocation (openDAW vs local); merge stock + local.
- Peaks/waveform generation (multi-stage pyramid) + storage + regen fallback.
- Delivery to worklet: `fetchAudio(uuid) → AudioData` (SharedArrayBuffer); worklet sample/soundfont loader & manager; reference by UUID.
- Lifecycle: lazy load, in-memory cache + refcount, pending-load dedupe, eviction, orphan/trash cleanup.
- Loader states (idle / progress / error / loaded / record); missing-asset replacement flow.
- P2P / cloud providers (chained sources) — *likely out of scope for engine core, listed for completeness.*

## 12. Device chains & parameters (categories only)
- Hosts: instrument host (one input: instrument or bus), MIDI-effect chain, audio-effect chain.
- Per-device: enabled/bypass, minimized, index/order in chain; sidechain pointer.
- Categories: instruments, audio-effects, MIDI-effects (**not** enumerated here).
- Parameters = automatable fields with mapping/units; per-device parameter sets.
- Unknown-device fallback (preserve unsupported devices in the graph).

## 13. Metering & analysis
- Peak (exp decay ~250 ms) + RMS (~100 ms window) per channel, per block.
- FFT spectrum (decaying) + waveform capture, only when subscribed.
- DSP-load measurement (high-res clock, perf ring buffer).
- Per-unit output-buffer registry (metering taps).

## 14. Recording & monitoring
- Capture audio (deviceId, channels, gain, input latency, record mode).
- Capture MIDI (deviceId, channel, record mode).
- Recording processor → lock-free ring buffer to main thread (atomic read/write pointers, wraparound, Atomics.wait/notify).
- Monitoring mix (input → monitor out, latency-free conditional wiring); per-device monitoring map; count-in integration.

## 15. Metronome / click
- Click at beat / sub-beat (signature-aware), envelopes, monophonic fade between clicks, enable flag.

## 16. External MIDI I/O
- MIDI sender (sample-accurate, via SharedArrayBuffer + port).
- MIDI transport clock (start/stop/position + 24 PPQ clock); per-device timing offset.

## 17. Modular system
- Modular setup: modules + connections (patch graph); audio in/out modules; basic modules (gain/delay/multiplier); per-module connectors.

## 18. Grooves / swing
- Groove (shuffle) timing grid applied to note timing/quantization.

## 19. Engine control & state sync
- Command protocol (15 commands, via the worklet port / Communicator): play, stop(reset), setPosition,
  prepareRecordingState(countIn), stopRecording, queryLoadingComplete, panic, noteSignal,
  ignoreNoteRegion, scheduleClipPlay, scheduleClipStop, setupMIDI, loadClickSound, setFrozenAudio,
  updateMonitoringMap.
- Two back-channels engine → UI, both over SharedArrayBuffer with lock-free Atomics (no postMessage in
  the hot path); the dynamic one is subscription-aware (only computed when the UI is listening):
  - Fixed state (SyncStream, one struct per render): position, bpm, playbackTimestamp,
    countInBeatsRemaining, isPlaying, isRecording, isCountingIn, perfBuffer[512], perfIndex. In the new
    engine these are fetched as scalars from the wasm each block and written into the struct.
  - Dynamic streams (LiveStreamBroadcaster, address-keyed, variable size): PEAKS (peak + RMS per unit),
    SPECTRUM (FFT bins, needs an FFT), WAVEFORM, per-parameter value addresses, per-unit note broadcaster.
- Marker state; note on/off broadcast; parameter-write notifications.

## 20. Numerical robustness & real-time rules (cross-cutting)
- Per-sample ramps for gain/pan/matrix (declick); one-pole parameter smoothing.
- NaN/sanity detection; denormal mitigation.
- Voice fade-outs to avoid clicks on stop/steal/discontinuity.
- Cached topological sort: processor order computed once per wiring change, reused across renders.
- Deterministic seeded randomness: the note sequencer's chance gate uses a seeded RNG, so playback is reproducible.
- Zero allocation in the render loop: buffers and voices pre-allocated; allocation happens only at setup, wiring, or asset load.
- Wiring changes deferred to process-phase "before" (never mid-render); discontinuity flag propagates to reset read heads and voices.

## Appendix — device / processor types
The chain plumbing in section 12 is device-agnostic; for scope, the engine currently instantiates ~34
processor types (their DSP is the bulk of the per-device work, not detailed here):
- Instruments: Tape (sampler), Vaporisateur (wavetable), Nano (3-osc), Playfield (granular), Soundfont
  (SF2), Apparat (drum / step sequencer), plus MIDIOutput (routes MIDI to an external device).
- MIDI effects: Arpeggio, Pitch, Velocity, Zeitgeist, Spielwerk, plus an unknown-device fallback.
- Audio effects (~19): Delay, Reverb (FreeVerb), Dattorro reverb, StereoTool, Maximizer, Compressor,
  Gate, Crusher, Fold, Waveshaper, Vocoder, NeuralAmp, Modular, Werkstatt, Revamp, Tidal, and the rest,
  plus an unknown-audio-effect fallback.
- Plus the AudioBus (summing) processor.
- EventSpanRetainer backs the note sequencer's active-note lifecycle (note-on held until its note-off).
