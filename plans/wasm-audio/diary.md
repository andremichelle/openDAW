# Diary

## Day 1: foundations

- Sine: Rust DSP to wasm, played in an AudioWorklet, with a test app and a live deploy. Done.
- Composition spike: independent wasm modules share memory and call each other; plugin and memory model validated. Done.
- Parity harness: native unit tests plus offline wasm-vs-TS null tests in CI. Done.

## Day 2: data layer, live sync, and the metronome

- BoxGraph in Rust: ported and proven by loading a real project byte-for-byte. Done.
- Schema registry: the TS box-forge now also generates the Rust registry from the same schema. Done.
- Updates and sync-log replay: apply and undo the update stream; a recorded session replays end to end. Done.
- Checksum: a Rust graph checksum that matches the TS one exactly. Done.
- Live sync: the unchanged SyncSource streams every transaction into the wasm engine, checksum-validated. Done.
- Subscriptions: the Rust graph notifies listeners on changes, with clean removal. Done.
- Transport: PPQN time conversions and a block-by-block transport clock. Done.
- Metronome: a live page where the engine renders the click and reacts to bpm and signature edits in real time. Done.
- Allocator: replaced the bump allocator with talc (`WasmDynamicTalc`), which reclaims freed memory and grows via `memory.grow` on demand; +4% wasm size. Done.
- ValueEvent evaluation: a value-event model with hold, linear, and curve interpolation, value-at-position lookup, and a sorted event collection with range queries. Done.
- Math crate: a shared lib-std-equivalent crate (clamp, lerp, curve math) backing the engine crates, libm-backed so host and wasm compute identically. Done.
- f32 control path: control values, bpm, and sample rate moved to f32 while absolute positions stay f64 for sample-accuracy over long timelines. Done.
- Bindings crate: a studio-adapters-equivalent layer that materializes boxes into the runtime values the engine evaluates. Done.
- Pointer-hub subscription: the PointerHub onAdded and onRemoved analog, so the membership of pointer-built collections is observed directly. Done.
- ValueCollection: the Rust ValueEventCollectionBoxAdapter, an event collection kept in sync incrementally from membership and edit events with no periodic rebuild. Done.
- Subscription refactor: observers now receive the committed graph when they fire, so collections build straight from change events, and the subscription registry stays a member of the graph. Done.
- Tempo automation: a varying tempo map drives the metronome bpm, splitting each block at the tempo grid. Done.
- Loop area: the block loop wraps playback at the loop end with sample accuracy, re-evaluating bpm at the loop start, and the loop wins ties when its end falls on a tempo grid. Done.
- EngineState back-channel: the engine writes position, bpm, and transport state into a buffer matching the real EngineStateSchema byte layout, decoded on the main thread by the same schema. Done.
- Tempo Automation page: a live page that accelerates 30 to 1000 bpm over a four-bar loop, with a tempo-automation toggle, a bpm slider, and a curved first segment. Done.
- Code cleanliness: clippy-clean across the host and wasm targets, with unnecessary public surface and dead code trimmed, and field accessors replacing hand-written variant matches. Done.

## Day 3: notes, loopable regions, and audible voices

- NoteEvent + EventSpan: a note model (pitch, cent, velocity, duration) on a span trait, ordered like the TS comparator. Done.
- Loopable-region math: `locate_loops` yields the loop cycles a block overlaps, mapped to global / region / window spans, the shared basis for note, audio, and automation regions. Ported from the TS LoopableRegion tests. Done.
- EventSpanRetainer: holds notes that outlive the block that started them, releasing them when their span completes or on a stop / loop wrap. Done.
- ADSR envelope + pitch: a per-sample ADSR state machine and the MIDI-pitch-to-frequency mapping, the basis of an audible voice. Done.
- NoteSequencer: the Rust counterpart of the core-processors sequencer, focused on the timeline path. Per block it starts notes whose onset falls in the block (one per loop cycle) and stops retained notes when they complete or on a discontinuity, emitting sample-accurate note-on / note-off. Done.
- Sine instrument + audio buffer: a minimal polyphonic instrument (one sine voice with an ADSR per note) that renders the sequencer's note lifecycle into a stereo render-quantum buffer, sample-accurately. Done.
- NoteCollection binder: the box graph to notes bridge, an incrementally maintained note collection mirroring the value collection. Done.
- Audible end to end: a pure-Rust test drives a looping note region through the sequencer and instrument over a real block loop and confirms recurring audio, proving the note-to-sound path before any browser. Done.
- Still to wire: hosting the sequencer + instrument inside the WASM engine and a test page, so the notes are heard live (all the pieces are built and tested).
