# Diary

## Day 1 (2026-06-16): foundations

- Sine: Rust DSP to wasm, played in an AudioWorklet, with a test app and a live deploy. Done.
- Composition spike: independent wasm modules share memory and call each other; plugin and memory model validated. Done.
- Parity harness: native unit tests plus offline wasm-vs-TS null tests in CI. Done.

## Day 2 (2026-06-17): data layer, live sync, and the metronome

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

## Day 3 (2026-06-18): notes, loopable regions, audible voices, the device as a real plugin, and per-unit instruments

- NoteEvent + EventSpan: a note model (pitch, cent, velocity, duration) on a span trait, ordered like the TS comparator. Done.
- Loopable-region math: `locate_loops` yields the loop cycles a block overlaps, mapped to global / region / window spans, the shared basis for note, audio, and automation regions. Ported from the TS LoopableRegion tests. Done.
- EventSpanRetainer: holds notes that outlive the block that started them, releasing them when their span completes or on a stop / loop wrap. Done.
- ADSR envelope + pitch: a per-sample ADSR state machine and the MIDI-pitch-to-frequency mapping, the basis of an audible voice. Done.
- NoteSequencer: the Rust counterpart of the core-processors sequencer, focused on the timeline path. Per block it starts notes whose onset falls in the block (one per loop cycle) and stops retained notes when they complete or on a discontinuity, emitting sample-accurate note-on / note-off. Done.
- Sine instrument + audio buffer: a minimal polyphonic instrument (one sine voice with an ADSR per note) that renders the sequencer's note lifecycle into a stereo render-quantum buffer, sample-accurately. Done.
- NoteCollection binder: the box graph to notes bridge, an incrementally maintained note collection mirroring the value collection. Done.
- Audible end to end: a pure-Rust test drives a looping note region through the sequencer and instrument over a real block loop and confirms recurring audio, proving the note-to-sound path before any browser. Done.
- Engine hosting: the sequencer and sine instrument run inside the WASM engine on an EngineContext graph, driven block by block and mixed into the output buffer. The Notes and Loop Truncation pages now play note regions live, with mirrored regions sharing one arpeggio across a loop split at bar two. Done.
- Runtime plugin loading: the sine instrument is its own `device_sine.wasm`, loaded as a separate module that shares the engine's single linear memory and is called wasm-to-wasm through the abi descriptor with zero copy. The device is heap-free, its per-voice state living in an engine-allocated block. Done.
- Per-audio-unit instruments: the graph builder creates one instrument per audio unit, grouping note regions by their owning unit through pointers, region to track to unit. Each instrument calls the one loaded device with its own state block, so units play independently on a single device.wasm. The Multiple Plugins page proves it: a slow low bass under a fast high arpeggio, two units at once. Done.
- Shared linear memory: the engine's memory is now a shared memory created on the main thread and handed to the worklet, so the main thread can see the WASM heap directly. Built on stable with the shared-memory link flags and no atomics, no build-std. Runs cross-origin isolated in the browser. This is the ground for writing decoded sample data straight into the heap at an engine-allocated offset. Done.
- Still a deviation: every unit uses the sine device, since the unit's real input instrument and audio-effect chain are not read yet.

## Day 4 (2026-06-19): runtime device plugins via dynamic linking

- Dynamic-linked device plugins: devices are now position-independent side modules the engine loads at runtime, each at a memory base the host assigns from the heap, so any number of distinct devices coexist in the one shared memory with no fixed addresses and no build-time coordination. The engine is the dynamic linker: it owns the shared linear memory and function table, hands each loading device an allocation and the bases it needs, and calls every device through the shared table. This is what makes third-party devices possible. Done.
- A second device: a sawtooth instrument built from the sine one, loaded beside it. A harness against the real modules confirms both load at distinct bases in the one memory, both render, and the two waveforms differ, proving the multi-device memory model end to end. The Multiple Plugins page now drives the two device types. Done.
- Build: the devices build on nightly with a rebuilt standard library (the shipped one is position-dependent), with immediate-abort panics and hidden symbol visibility so the unused standard library is pruned away, leaving a two-kilobyte module with no global-offset table for the loader to resolve. The engine and the standalone sine page stay on stable. Done.
