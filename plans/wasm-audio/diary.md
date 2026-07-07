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

## Day 4 (2026-06-19): dynamic-linked devices, and the device-engine interface

- Dynamic-linked device plugins: devices are now position-independent side modules the engine loads at runtime, each at a memory base the host assigns from the heap, so any number of distinct devices coexist in the one shared memory with no fixed addresses and no build-time coordination. The engine is the dynamic linker: it owns the shared linear memory and function table, hands each loading device an allocation and the bases it needs, and calls every device through the shared table. This is what makes third-party devices possible. Done.
- A second device: a sawtooth instrument built from the sine one, loaded beside it. A harness against the real modules confirms both load at distinct bases in the one memory, both render, and the two waveforms differ, proving the multi-device memory model end to end. The Multiple Plugins page now drives the two device types. Done.
- Build: the devices build on nightly with a rebuilt standard library (the shipped one is position-dependent), with immediate-abort panics and hidden symbol visibility so the unused standard library is pruned away, leaving a two-kilobyte module with no global-offset table for the loader to resolve. The engine and the standalone sine page stay on stable. Done.
- The interface, designed and written down: a full read of the TS core-processors engine, reconciled with the Rust side, became one plan for what every device needs from the engine and the small ABI plus host-import table that serves MIDI effects, instruments, audio effects, sidechain, the timeline-reading Tape device, and composite devices. The phasing in it is the build order. Done.
- Events became a pull: the engine stopped handing instruments a resolved event list. A device now pulls its own notes for a pulse range through a host import and times its own sub-blocks, the descriptor carrying the quantum blocks and a scratch the pull fills. The whole MIDI chain works in pulse positions and the instrument resolves sample offsets only at the end, the shape of the TS engine. Done.
- A device SDK: small templates so an author writes only DSP. An instrument writes the voice render and the note handler, an audio effect writes one process call, a MIDI effect writes a transform or a pull responder. The SDK owns the pull, the block fragmenting, and the dispatch. Done.
- Audio effects: a host effect node and a low-pass device wired after an instrument, instrument to effect to bus, ordered by the graph. The low-pass is a tempo-synced auto-wah, its LFO locked to the song position and its coefficient derived from the sample rate. Done.
- MIDI effects as a pull chain: a MIDI effect is a pull-chain link, not an audio node. Built a transpose, an arpeggiator that holds a chord in its state block and turns it into a stepped stream that keeps going across blocks with no new input, and a simple Zeitgeist groove that shuffles by warping note positions in time, pulling its upstream over the un-warped range. They stack, so the lead runs sequencer to arp to shuffle to transpose to instrument. Done.
- Device kinds and instance state: a device declares whether it is an instrument, an audio effect, or a MIDI effect so the host knows how to wire it, and each instance gets a stable host-allocated state block, the home for held-note stacks and filter memory. Done.
- The Multiple Plugins page proves the lot: a tempo-synced auto-wah sawtooth bass under a shuffled, octave-up arpeggiated sine chord, six device plugins coexisting in the one shared memory, two instruments, an audio effect, and a three-stage MIDI-fx chain. Done.
- Still ahead: devices are assigned by unit index, not yet read from the box, and parameter automation, samples, the timeline query, sidechain, and composite devices are the next routes.

## Day 5 (2026-06-22): generic plugin nodes, the channel strip, and the unit cascade

- Generic plugin hosting: the engine stopped hardcoding the instrument and now wraps any loaded device in a generic node, PluginInstrument, PluginAudioEffect, or PluginMidiEffect, driven entirely by the device's registration and kind. Adding a device type needs no engine change, and the whole device set is realized from the box-type to plugin table. Done.
- Devices read from the box: a unit's three device chains, the input instrument, the midi-effect chain, and the audio-effect chain, are now read from the unit's box fields and ordered by each device's index, replacing the by-unit-index assignment. So the box decides what plays. Done.
- Channel strip: a per-unit strip with volume in dB, panning, and mute, smoothed by a ramp and bound to the unit's box fields, terminating each unit's chain into the master bus. The output unit's strip is the engine's final master. Done.
- The audio-unit cascade as its own module: the unit to tracks to regions to collections hierarchy moved out of the engine core into a reactive module, catch-up plus subscribe at every level, so a main-thread edit at any depth reaches the running engine and only rewires the unit whose scope changed. Done.
- Region math: more loopable-region helpers and value-region range queries, ported with their TS tests. Done.

## Day 6 (2026-06-23): parameter automation, biquads, and a typed parameter wire

- Parameter automation, the pull model (Route D): a device binds each parameter by its stable field-key path through bindParameter, and the engine observes that box field's value and any automation track. Static and edited values are pushed to the device at build time; automated values are pulled on an update clock during render. The engine stays mapping-agnostic, it never learns a device's mapping. Done.
- Reactive rebind: automation attaching or detaching at runtime re-observes a unit's curves and re-pushes the values without rewiring the audio graph, the analog of the TS bindParameter reacting to a parameter's automation hub. Done.
- Biquad DSP: ported the TS BiquadCoeff and BiquadProcessor to the dsp crate, and the low-pass became a real filter with an automatable cutoff and resonance, dropping the old internal LFO. A second automation ramps the resonance over the loop. Done.
- MIDI-fx automation: a midi-fx parameter automates exactly like an audio device's. The pull responder splits its range at the update positions and refreshes its parameters per sub-range, so the transpose's semitone is automatable, stepped up an octave after a bar from a uniform curve. Done.
- The update clock moved engine-side: the injected clock events are gone. Each render template fragments locally at the engine's update positions, which return infinity when a device has no automation so it simply does not split. The per-block seed is inclusive, so a grid point exactly on a block start fires, and the in-loop advance is strict, so the loop always moves forward, mirroring the TS Fragmentor. Done.
- Typed value mappings: a ValueMapping generic over its output type, Linear and Exponential to f32, LinearInteger to i32, Bool to bool, mirroring lib-std and owned by the device. An automation curve is always uniform 0..1, and the device maps it to the parameter's real type. The wire carries a kind tag plus one value, and the SDK decodes it into a typed ParamValue the device matches on, so device code has no casts and no flags, and a value of the wrong type for a parameter panics rather than being silently coerced. Done.
- process_audio signature cleanup: the sample rate left the per-call signature, since a device stashes its own rate in state, and the audio effect now receives the chunk's Block, its pulse range, tempo, and flags, with the sample indices rebased to the already-sliced buffers and one-shot flags cleared after the first chunk, replacing the loose bpm and position that went stale on a split. Done.
- The Multiple Plugins page proves it: a low-pass cutoff swept by a sine curve over a resonance ramp on the sawtooth bass, and the sine arpeggio's transpose stepping up an octave after a bar, every parameter driven by a uniform automation curve mapped to its own real type. Done.
- The mapping library completed to the full lib-std set: Linear with unipolar and bipolar, LinearInteger, Exponential, Power with a by-center constructor, Decibel for volume and gain, Values for discrete sets, and Bool, each generic over its real output type and unit-tested against the TS shapes, so any device to come has the mapping it needs. Done.
- A render hot-path allocation audit: confirmed no per-quantum heap allocation anywhere in the plugin path, the nodes mutate a pre-built descriptor in place, the SDK templates use stack scratch, and the event scratch and block list are reused buffers that settle at their high-water mark. Done.
- Stereo device I/O: devices now carry true stereo content, not just stereo placement. The descriptor declares two input and two output channels, the SDK passes the channels as a `[left, right]` array (mirroring lib-dsp's StereoMatrix) to a device's process and finish, and the plugin nodes wire both channels of the upstream buffer in and copy both out instead of fanning a mono signal. The instruments write the same to both, the low-pass runs one biquad per channel, and the engine's buffers and channel strip were already stereo, so the chain is stereo end to end. The engine stays firmly two-channel, no speculative N-channel. Done.
- A first real stock effect, Tidal, ported to the letter: a tempo-synced auto-pan / tremolo. The lib-dsp TidalComputer (the depth / slope / symmetry LFO shaper) and the one-pole Smooth were ported to the dsp crate in f64 to match the TS math, and the device drives them exactly as the TS processor does, the LFO phase read from the song position so it locks to tempo, a per-channel phase offset moving left and right apart, one smoothed gain per channel, and the six parameters with their real mappings. Unit-tested for the LFO shape and the stereo split. Done.
- A single PPQN home: the pulse conversions now live once in dsp (mirroring lib-dsp ppqn.ts), the host's engine-env re-exports them, and a device reaches them through its dsp dependency, so no one inlines the constants and there is one implementation of the contract formulas. Done.
- Master / output-unit effects: the engine now wires THE output unit's own audio-effect chain between the summing bus and the master strip, binding each device's parameters like an instrument unit's, so an effect can process the whole mix and not just a single unit. Done.
- A Tidal page: a sine synth playing a semiquaver arpeggio into a Tidal effect on its own chain, with a slider per parameter (slope, symmetry, rate, depth, offset, channel offset). Each slider edits the device's box field live, the SyncSource streams the edit, and the engine re-pushes the value to the device, so the parameters move while it plays and the channel offset opens the tremolo into an auto-pan. Done.
- A shared engine host: the per-page boot was the same copy each time, so it moved into one createEngineHost helper that boots the worklet engine, loads the device modules, streams the page's box graph through the SyncSource, decodes the state back-channel, and owns play / stop / teardown. The instrument and effect pages now call it in a line instead of repeating it; the metronome page keeps its own boot since it watches the heap back-channel rather than transport state. Done.
- A shareable polyphony framework, the voicing crate: a heap-free port of the TS voicing framework. One Voice trait for a synth's per-note DSP, the two VoicingStrategy implementations, PolyphonicStrategy (a fixed voice pool with free-slot, steal, and glide-from-released) and MonophonicStrategy (one voice plus a held-note stack with legato glide and glide-back), VoiceUnison (N detuned and spread sub-voices played as one note, itself a Voice so it nests into either strategy), and the Voicing dispatcher that switches mode at runtime, force-stopping the outgoing strategy while it decays. All const-generic over the voice and stack counts, with the voices living in the device's zeroed state, so no allocation per note. The voice reads the device's live parameters through a Shared associated type at note-on and each chunk. Unit-tested across poly, mono, unison, and the dispatcher. Done.
- Shareable synth DSP primitives, ported to the dsp crate and unit-tested: a band-limited oscillator (naive sine plus PolyBLEP saw, square, and a leaky-integrated triangle), a Glide for tempo-relative portamento, a ModulatedBiquad whose per-sample cutoff is quantised and recomputed only on change, a one-pole Smooth, stereo panning, a SimpleLimiter, and an LFO. Each mirrors its lib-dsp counterpart so any synth to come has the parts it needs. Done.
- The Vaporisateur, ported to the letter: a polyphonic two-oscillator subtractive synth as a runtime-loadable device. Two band-limited oscillators (per-osc waveform, octave, tune, volume) mixed into a modulated multi-pole low-pass (cutoff, resonance, filter envelope, keyboard tracking), shaped by an ADSR VCA, with glide, an LFO targeting tune, cutoff, and volume, unison, poly or mono voicing, and a brick-wall limiter on the mix. The ADSR is a local faithful port of lib-dsp adsr.ts, the shared dsp envelope stays untouched. All twenty-seven parameters bound by their stable field-key paths (including the nested oscillator-array and LFO-object fields) with their exact value mappings, so the engine stays mapping-agnostic. The per-block scratch is a single workspace reused by every voice, so there is no per-call allocation. Native-tested for an audible bounded tone, release to silence, the filter attenuating a bright saw, and polyphony summing voices. Done.
- Shared render constants: RenderQuantum moved into the dsp crate and clampUnit into the math crate, so a device no longer redefines them. Done.
- A Load File page: loads a serialized openDAW project, a .od file, straight into the wasm engine through ProjectSkeleton.decode and the unchanged SyncSource, instead of building the box graph in code. The Vaporisateur is wired as the real device behind the VaporisateurDeviceBox type, and a small helper gives a freshly created box an audible sine preset since the schema defaults its oscillators to silent. The placeholder device_sine plugin was retired. Done.
- A monophonic glide-back parity question, analysed and parked: loading a mono glide patch revealed that the wasm glides the voice back down a held chord on staggered note releases (matching TS) but just releases at the top note when a chord's notes all end on the same instant, because the order of simultaneous note events is not pinned down in the device dispatch. Confirmed by replaying the project's notes through the real sequencer and strategy that the glide-back logic is a faithful port and the divergence is purely this tie ordering. Recorded in future-plans with repro files for a later TS comparison. Done.
- Still ahead: samples and the audio-data path, the timeline query and the Tape device, sidechain, and composite devices.

## Day 7 (2026-06-24): the audio-data path, Nano, and the Delay

- The audio-data path (Route F): the engine requests a sample per AudioFileBox, allocates the block off the hot path, and the main thread writes the decoded planar frames into the shared memory. The audio thread only consumes, import and recording both deliver the same way. Done.
- Typed worklet to main channels via the lib-runtime Communicator, no more raw port.onmessage. Done.
- Nano, a sampler instrument ported to the letter, requests its sample and plays it the moment it loads. Done.
- The Delay, a stereo tempo-syncable effect ported to the letter, rate-sized buffers in the device's zeroed tail. Done.
- A shared engine HUD across every page: Resume / Suspend gated by the real AudioContext state, the engine state and heap in aligned grid tables, the log at the foot. Sine and Metronome redesigned onto it. Done.
- Composite devices, a generic engine mechanism: a device box that, instead of being one leaf DSP, hosts a child collection of its own instruments, each child a full instrument with its own chains, summed into one output. The engine learns a composite only as a registered spec, the child collection's host field, the child index and routing key, and the choke-group flag key, with no box name or field key hardcoded. A composite builds recursively, each child realized by its OWN box type, a leaf device or a nested composite, so a composite may contain composites with no special case. The Playfield is the first and only registration, the mechanism is Playfield-agnostic. Done.
- Pure broadcast, the child decides routing: the composite broadcasts the identical note stream to every child and never filters. A Playfield slot filters its own note itself, it subscribes to its own index box field through catchup_and_subscribe, which runs only inside transactions and never during render, and drops every note but the one it is mapped to. A full instrument child filters nothing and plays all, so two full instruments can react to the same note track each with their own midi and audio chains. Done.
- A typed field wire, observe_field and FieldValue: a device observes a plain box field by its stable key and the engine delivers its value through a field_changed callback wrapped in a FieldValue, an enum that carries any primitive, int, float, bool, or string, decoded from a kind tag and panicking on an unexpected type, the mirror of ParamValue. A field observation is distinct from the parameter course, it is never mapped, never automated, and never read during render. Done.
- The sample pointer made reactive, observe_sample: the sample left the parameter course entirely. A device observes its file pointer and the engine delivers the resolved handle as an Option through a sample_changed callback, so both an add and a remove reach the device, fixing the old binding that latched a handle on once and could never clear it. Done.
- Choke and exclude, a generic per-child group: a child carries a choke-group flag field, and when one group member fires the composite injects a CHOKE event, ranked before note-on, into every sibling member through its slot route. The device force-releases all its voices fast on the CHOKE, no click and no frame counting, the block simply continues, the classic hi-hat choke. The composite reads the group from the children's exclude fields, the only Playfield-shaped part and acknowledged as such. Done.
- Per-child fx chains: each composite child now folds its OWN midi and audio fx chains around its instrument, built by the very same shared cluster builder a unit uses. The chain host field keys are declared by the child DEVICE itself, exported from the plugin and stored in its registration, not by the composite, so different child instruments may host their chains at different keys and nothing box-specific lives in the composite. The chain observations live in the composite binding, so a live add or remove of a child effect re-dirties the unit and rewires. This made a delay added to a Playfield clap audible. Done.
- Shared typed-value helpers and a naming sweep: float_value, int_value, and bool_value moved next to ParamValue in the abi, generic over a device's mapping and panicking on a parameter value of the wrong type, so every device decodes a parameter identically with no local copies. And every device's parameter-id field was renamed to match in full the state field it writes, sample_start_id, pitch_cents_id, offset_degrees_id, and so on, no shortenings, across all plugins. Done.
- The Multiple Plugins bass fixed: the left channel had always been silent because its bass was a Nano with no sample pointer, a sampler with nothing to play. Swapped to a Vaporisateur with a monophonic saw bass preset, the cutoff left wide open so the page's tempo-synced auto-wah does the filtering, mirroring the lead's sine preset helper. Done.
- Still ahead: the Tape device, the timeline query, and sidechain.

## Day 8 (2026-06-25): a generic composite, sidechain, the Gate, and a real transport

- The composite generalised off the Playfield, the CompositeDeviceBox: a plain composite that bundles two full instruments, a Nano and a Vaporisateur, both playing the same note stream, proving the composite mechanism was never Playfield-shaped. A new Composite page mounts it, and the two synths sound as one layered instrument. Done.
- Per-child fx without touching a plugin, the CompositeCellBox: the idea was to add midi and audio effects to an instrument without changing the instrument's own schema, so a cell box wraps a child instrument and hosts its midi and audio chains itself, carrying a display index. A composite of cells gives every nested instrument its own different chain, a delay on the Nano and an arpeggiator on the Vaporisateur in the same composite, and the plugin schemas stay untouched. Done.
- Sidechain as a unified input port, not a special case: a device names its through-signal input MAIN_INPUT, id one, and binds any number of extra inputs by a path through bind_sidechain, each resolved the same way the through-signal is, by resolve_input, the exact shape of resolve_sample. The engine swaps an INPUTS cell per effect process the way it swaps the pull link, and host_resolve_input reads it, so a device asks for an input by id and gets a stereo reference or nothing, with no sidechain-specific descriptor section and no ceiling on the number of sidechains. Done.
- The output registry that makes sidechain resolve build-order-free: an AudioOutputBufferRegistry maps a box address to its rendered buffer, populated both by a unit's strip output and by a composite's children, so a sidechain pointing at a Playfield sample slot finds it. The resolution is retried every reconcile, so it does not matter whether the source or the sink is built first, the edge is registered the moment both ends exist. Done.
- The Gate, ported to the letter: a sidechain-ducked gate whose detector follows a sidechain signal, opens and closes the through-signal, and whose floor sets how far it ducks. The DSP follows the TS Gate sample for sample so it sounds the same, and the floor automation was brought to parity by reading the parameter's value mapping from the TS adapter, the decibel mapping createParameter declares, not the box schema's constraints, the source of an earlier divergence where the wasm ducked later than the TS over an automated floor sweep. Done.
- A real transport, Play / Pause / Stop: the engine starts stopped, Play runs the transport, Pause freezes it keeping every plugin and buffer, and Stop rewinds to zero and resets the whole graph. A reset ABI hook reaches every device through reset_all, and each device empties its runtime state, an instrument drops its voices, a delay and the tails clear, a filter and a detector reset, while the parameter and sample bindings stay, so Play after Stop starts clean and silent. The page HUD gained Play, Pause, and Stop buttons gated by the live transport state, replacing the raw Resume and Suspend. Done.
- Pause made musical, then correct: pausing first gated the whole graph and cut the audio dead, a click and a frozen chord, so the graph was changed to keep processing one more quantum while paused, the tails ringing out. Then the held notes were made to release rather than hang, by mirroring the not-transporting branch of the TS BlockRenderer, a free-running position that keeps the pulse range advancing while the song position stays frozen, so the sequencer's non-playing pull flushes its held notes into note-offs with a valid pulse-to-sample mapping, the voices go to release, and the effect tails decay, instead of a degenerate empty block that froze everything. Done.
- Still ahead: the Tape device, the timeline query, the tempo-synced LFO honouring the transporting flag so a long pause does not drift its phase, and the composite-unification that folds the Playfield into the generic cell shape.

## Day 9 (2026-06-26): surgical reactive updates, and a scrubbable sync-log

- A flow diagram of the whole engine, written down as one SVG in the docs: the four layers, the main thread streaming box-graph edits, the worklet host rendering 128-frame quanta, the per-unit processor graph, and the device plugins as position-independent side-modules in the one shared memory, with the ABI host-import bus and the audio-data path drawn in. A picture of where the engine actually stands. Done.
- A correction worth recording: I had carried a stale belief that the engine still read note regions directly with no real track binding. It does not. The reactive AudioUnit to Track to Region to NoteEventCollection cascade has been there since the audio-unit module landed, catch-up plus subscribe at every level, so track binding is real and proper. Fixed the note, did not re-build what already worked. Done.
- The headline: the engine's reactive updates went from a sledgehammer to a scalpel, mirroring how the TS is optimised for edits. The old shape reconciled ALL audio units after EVERY transaction and fed its dirty flags with broad all-updates observers. The new shape touches only what changed. A whole plan, engine-updates.md, captured the requirements to the letter (no all-updates listeners, no reconcile of large parts on a tiny or unrelated edit, equal or better than the TS, minimal clean code) and the strategy, and it was implemented phase by phase, green at each step. Done.
- Per-unit dispatch: each unit's own subscriptions enqueue THAT unit for reconcile through a small mark handle, and the reconcile drains only the enqueued units instead of walking every unit and track. An edit on one unit reconciles one unit, an unrelated transaction reconciles nothing, the Rust analog of the TS per-unit invalidateWiring. Done.
- An address-indexed dispatcher in the box graph: vertex monitors are bucketed by propagation and kept sorted by address, so This is a binary search, Parent probes the target's prefixes, Children is a contiguous range. A single field edit dispatches to the few monitors that watch it, not a linear scan, so adding many precise monitors is cheaper than a few broad ones, not a regression. Done.
- Deferred subscriptions, the Rust answer to TS DeferredMonitor: a box-graph observer holds only a shared graph and so cannot subscribe mid-callback, so it queues vertex or pointer-hub (un)subscriptions on a deferred handle that the graph applies after the transaction's dispatch (with catch-up for hubs). This is what lets a collection add and drop a PER-MEMBER monitor as members join and leave, exactly as the TS subscribes inside an onAdded. Done.
- Every all-updates listener gone, six of them, each replaced by targeted subscriptions: the note and value event collections observe each member event with its own monitor (the value curve fully reactive through the event's interpolation hub and a per-curve-box monitor for slope), the indexed device chain observes each member's index field for reorders, a note region observes its own span, and the AudioFileBox lifecycle became a fire-only-on-New-or-Delete listener. Zero subscribe-all calls remain in the engine and bindings. Done.
- Sidechain re-pointing made surgical: each declared port carries its own targeted monitor on its pointer field, so a re-point or detach enqueues just the owning unit, and a diff-based resolve pass swaps only the one edge that changed. The old all-units rescan and the broad pointer predicate are gone. Done.
- Automation made per-parameter: every bound parameter watches its own field value (a static edit pushes straight to the device), its automation pointer hub (a track attaching or detaching), and its track's region hub (a value region joining or leaving), each firing a small invalidate that re-binds only that unit's curves. The unit-wide automation observer, its device-uuid set, and the structural predicate were deleted. Done.
- A scrubbable Sync Log page, the read side of studio-core's SyncLogReader turned into a stepper: it loads a recorded .odsl (the first commit the project, each later commit one transaction), decodes it into a box graph wired to the engine through the unchanged SyncSource, and walks it transaction by transaction with rewind, scrub, and fast-forward, so the project builds up or down and you can press Play to hear it at any step. The navigation was extracted into its own module and tested. Done.
- Three bugs the stepper surfaced, each root-caused not patched. A burst of transactions raced the async engine-sync pipeline (it serialised tasks against a graph that had already advanced), fixed by yielding one transaction at a time, the same pause the canonical reader takes. Rewinding broke because the recorded log omits the deferred pointer resolutions the graph generates at endTransaction for a forward-reference within a transaction, so inverting the recorded updates was incomplete, fixed by capturing the COMPLETE applied-update list per step and inverting it in reverse, exactly as the graph's own rollback does. And a full rewind trapped the real engine with an unreachable, because a per-note edit monitor fired on the note box's own deletion and tried to re-read the gone box, a latent binder bug that any runtime note or event deletion would hit, fixed by skipping the re-read when the box is already gone. A test drives the actual engine.wasm forward to the end and back to the start to guard all three. Done.
- Still ahead: the per-member processor lifecycle (a chain edit still rebuilds its one unit's whole cluster and resets that unit's DSP state, where the TS keeps surviving processors alive and re-wires only edges, planned in engine-updates.md for a dedicated pass with audio-level tests), plus the standing list, the Tape device, the timeline query, and the composite-unification.

## Day 10 (2026-06-28): the per-member processor lifecycle

The standing item from Day 9, closed. A chain edit used to rebuild a unit's whole processor cluster and reset that
unit's DSP, where the TS keeps surviving processors alive and re-wires only the edges. Reworked the leaf and the
composite paths so a device that survives a chain edit keeps its state and only its connections change, no
parameter push and no reset, the same edge-only re-wire the TS `invalidateWiring` does per unit. Sample disposal on
delete freed. Done.

## Day 11 (2026-06-29): enable and disable, everywhere, edge-only

Bypass across the whole graph, each toggle edge-only so it costs only the connection. A device (audio or midi
effect) enable and disable that skips or includes it in the wire without a rebuild, track enable and disable for
note and automation tracks, and instrument, composite, and slot enable and disable. A plugin enable and disable
list in the LoadFilePage to isolate what each of a project's devices contributes. Alongside it a cleanup pass,
named field-key constants, targeted automation-region discovery, allocation-free note release, and a QA hardening
round (dead code, dedup, a leak fix, render reserves). New coverage, real-instrument differential and fuzz audio
tests, a deterministic sync drain that de-flakes the integration harness, and automation curve-boundary tests.
Done.

## Day 12 (2026-06-30): audio-region playback, tape, and a tempo-correct timeline

The audio groundwork, a track cascade down to audio-bound regions feeding the sequencer, an engine-side tape read
head, and the TapeDeviceBox unit wired with a differential test. Then a transient-aligned time-stretch play-mode
over a tempo-correct timeline, so a warped audio region plays back at the project tempo. Done.

## Day 13 (2026-07-01): stock-device porting sweep, scriptable devices, and the bundle player

Ported 9 of the remaining stock devices to Rust/WASM, each faithful to the TS (source of truth), f32 internal
math, no allocations in the hot path, plus native DSP tests and a WASM wiring test per device:

- **Audio effects**: Waveshaper, Crusher, Fold (2x/4x/8x oversampling), StereoTool, Maximizer (look-ahead
  limiter), Compressor (CTAGDRC feed-forward, sidechain + auto attack/release/makeup), Reverb (Freeverb),
  DattorroReverb (plate).
- **MIDI effect**: Velocity (magnet + Mulberry32 seeded jitter + offset, byte-parity PRNG).

New shared DSP in `crates/dsp`: `db_to_gain`/`gain_to_db`, `ramp` (LinearRamp + StereoMatrixRamp), `waveshaper`,
`crusher`, `resampler` (polyphase halfband, replicating the TS undersized-array truncation), `panning`
(StereoMatrix update), `ctagdrc`, `freeverb`, `dattorro`; `math::random::Mulberry32` (TS byte-parity).

Two device patterns learned: a STRING/INT/BOOL non-param field is observed via `observe_field` + a `field_changed`
export (Waveshaper equation, Fold oversampling, StereoTool mixing, Maximizer lookahead); and a LARGE device state
(Reverb ~700 KB, Dattorro ~500 KB) must be zero-init IN PLACE (`dsp.init(&mut self)`) — building it by value in
`new()` overflows the 256 KB device stack (silent NaN/zero output).

`build-wasm.sh` now loops over a `DEVICE_CRATES` list; adding a device is one entry there + one in
`engine-modules.ts` + `load-full-engine.ts`. All box schemas were already in `studio-boxes/registry.rs`.

MIDIOutput: intentionally NON-functional and needs no crate — the engine already renders an unregistered
instrument box type as a silent unit (`audio_unit.rs` "not a buildable instrument: silent"), and the box registry
decodes its boxes, so projects with a MIDIOutput load fine.

Deferred (each a large focused effort): **Vocoder** (761-line filter-bank DSP; portable, no engine change),
**Soundfont** (SF2 sample-data delivery — an engine/data change), **NeuralAmp** (NN-weight delivery — an
engine/data change). The latter two hit the "significant audio-engine change" stop condition.

Three of openDAW's devices are scriptable, their DSP is user JavaScript rather than Rust: Werkstatt (audio
effect), Apparat (instrument), Spielwerk (midi effect). I brought all three to the WASM engine WITHOUT porting the
scripts, by running each user Processor in the same AudioWorkletGlobalScope the engine already runs in.

- The linchpin is that the engine worklet and the user script share one global scope, so `globalThis.openDAW.<registry>[uuid]` is directly visible at render time. The WASM device is a thin bridge, three small side-module crates (device-werkstatt/apparat/spielwerk) that, instead of doing DSP, call new `host_script_*` env imports the loader binds to a JS `ScriptBridges` manager. The bridge re-derives its memory views every call (talc may grow the buffer), hot-swaps the Processor by an update counter, and validates the output. `host_self_uuid` is a real engine export so a device knows which registry entry is its own. Done.
- The reuse that made it small: a `WerkstattParameterBox.value` is automatable, and a Value track that automates it targets `(childBox_uuid, [4])`. The engine's existing automation binding keys by that address, so binding a script parameter against its CHILD box reuses ALL the region, curve, and update machinery with no change to `param_automation.rs`. A new `param_hub.rs` (`ScriptParamHub` / `ScriptSampleHub`) enumerates the parameters and samples hubs and aggregates their handles into the device node. The parsed `@param` / `@sample` declarations ride in the registry entry via `ScriptCompiler.wrap`, so the bridge maps an automation value through the identical `ValueMapping` on both engines and parity is clean by construction. Each device null-tests WASM against a TS-offline render. Done.
- The bundle player: a page that loads an `.odb` (a project plus its samples) from disk, writes every sample into a persistent OPFS cache (`samples/v2/<uuid>/audio.wav`, the same layout the studio uses) so a re-open needs no network, then boots the engine on the extracted box graph. A `SampleStorage` plus a cache-first loader. Done.

## Day 14 (2026-07-02): send and return, then soundfont playback

- Send and return routing: a unit's output can feed a bus (a submix) and it can also run parallel aux sends. A `bus_registry` plus `resolve_outputs` / `resolve_sends`, a `would_cycle` guard so a routing edit can never build a feedback loop, and an `AuxSendProcessor` that taps a unit pre-fader. This surfaced a real bug, a sidechained compressor ON a bus never resolved its sidechain (it was crushing its own hot synths), fixed by running an audio-track fx chain in the reconcile and by tapping the sidechain from the DEVICE output. A TS-versus-WASM differential harness on real projects (Chaotics, Ambition) proves the per-unit levels match. Done.
- Soundfont playback: the TS side still keeps and parses the `.sf2`, but the WASM engine receives a SIMPLIFIED binary blob (sample, region, and preset tables plus normalized f32 PCM) over the same request-allocate-resolve handshake the samples use. `device-soundfont` reads that blob in place with no allocation, and it needed an `Adsr` and a `Smooth` port plus a 128-voice pool. The SF2 generators the TS voice honors (key and velocity ranges, pan, loop mode, root key, the volume envelope) are mirrored exactly. Done.

## Day 15 (2026-07-03): the A/B page, parity fixes, engine review fixes, SIMD and a profiler, NeuralAmp

- The Performance A/B page renders a bundle front-to-end through BOTH engines offline in a worker, times only the render loop, and presents both as players you can flip between. It immediately earned its keep by exposing two silent-render bugs on "Open Up", each root-caused not patched. The scriptable-device scripts were never registered into the shared registry (the `registerScriptDevices` helper existed but nothing called it), so every chain that ran through a scriptable device went silent. And, WASM only, the hand-rolled registry entry omitted the parsed params and samples, so the bridge threw while loading and silenced the device, fixed by registering through the canonical `ScriptCompiler.wrap`. On the user's principle that the engine must report anything out of the ordinary, the bridge now emits a one-shot message when a scriptable device has no registered Processor rather than swallowing it. Done.
- A real arpeggiator. `device-arp` had been a dummy that hardcoded a 1/16 grid and read no parameters, so a project's 1/3 arp ran at 1/16. Ported in full to mirror `ArpeggioDeviceProcessor`: the rate from the descending `RateFractions` table through `Fraction.toPPQN`, the Up, Down, and UpDown modes with their octave and velocity math, gate, repeat, and the velocity magnet, with parameters honored mid-block by splitting the range at update boundaries like the SDK's midi-effect template. It is a stateful pull source that writes `process_events` directly rather than the one-to-one transform template. Proven end to end, a 1/3 arp steps at 1280 pulses and a 1/16 at 240 where the dummy gave 240 for both. Done.
- Strip automation. The AudioUnit volume and panning ignored their automation entirely, the channel strip only tracked the static box field, so a fader automated up from silence played at full level from the first sample. Wired volume (field 12) and panning (field 13) into the same parameter pipeline the device parameters use, evaluated per block at the transport position through the real decibel and bipolar mappings from the TS adapter, with the static field as the fallback before any region. A soloed unit whose volume automates from zero is now silent at the start and audible after the ramp. Done.
- A TS-versus-WASM parity hunt, because the page makes every fraction of a decibel visible. I added a third DIFFERENCE waveform and a null-test readout (loudness delta, null residual, max sample delta), and rebuilt the A/B switch to be sample-accurate by playing both renders through one Web Audio clock started together, so the two can never drift in PLAYBACK. That mattered, because the drift the ear caught in A/B was the old two-audio-element switch, not the engines. Cross-correlating the renders proved they stay time-locked to zero samples across a full minute. The remaining differences, all measured rather than guessed: the reverb-tail divergence is bounded floating-point drift and inaudible, an Apparat "Grain Synthesizer" calls `Math.random` so it can never null (a red herring), and the residual "the reverb sounds louder" on Open Up is a small SYSTEMATIC level bias, WASM a few tenths of a decibel hotter, spread across devices and biggest at the instrument, not the reverb. An f32-to-f64 pass on the Dattorro reverb improved the null residual but did not move the audible loudness, so it was reverted. The bias hunt is still open, the next step is a leak-free single-instrument null to read the exact gain difference in the sample path. Ongoing.
- The Vocoder, the last portable stock device (deferred on Day 13). A channel vocoder over a bank of up to 16 bandpass pairs, ported to the letter as `dsp::vocoder` (a `NoiseGenerator` with byte-parity white, pink, and brown, plus the `VocoderDsp` filter bank with its geometric coefficient interpolation, per-band envelope follower, bandwidth-compensated output gain, and click-free band-count fade) with the `device-vocoder` audio-effect crate on top. The CARRIER is the main input, and the MODULATOR is chosen by the `modulatorSource` string field, synthesised noise, the carrier itself as a multi-band gate, or an external sidechain resolved through the same input-port model the Gate uses. `bandCount` is a non-param field, and the spectrum-analyser and peak meters of the TS processor are UI-only and skipped. Native DSP tests plus a WASM wiring test (self-mode gate differs from dry, noise-mode is audible, both finite and bounded). Done. Only NeuralAmp (needs neural-net weight delivery) and the Modular device remain unported.

- A comprehensive engine review (clean code, performance, bugs), then the findings fixed in order: a `locate_loops` guard so a degenerate loop config can never hang the render, a strip-automation subscription leak (rebinds now `terminate()` their `ValueCollection`s, proven by a leak test), the Delay device wiping its tail on a loop wrap, the Pitch midi-fx which had been a stub and is now a full `PitchDeviceProcessor` port (octaves, semitones, cent), the Maximizer's wrong -24..0 dB parameter mapping, and the Dattorro excursion phase moved to f64. The topological sort was also rewritten allocation-free (sorted, states, and stack vectors reserved at reconcile, nothing allocates when the graph re-sorts mid-session), and the note sequencer's ratchet and lookback findings were fixed the TS-faithful way, the tests were wrong, not the code. Done.
- TAU, a lockstep correction. The Dattorro port carried `6.28` and `6.2847` from the TS source where TAU is plainly meant, so both engines now use the real constant, the TS reference included, since the reference itself was wrong. Done.
- SIMD, honestly. Enabling `simd128` alone changed nothing measurable, LLVM was already auto-vectorizing the hot loops it could and the rest is serial-dependency DSP. So instead of guessing, the engine grew a per-node render profiler (two clock calls per node, accumulators pre-grown at reconcile, zero allocation) and the optimization pass followed the measurements: the Dattorro ring buffers got const geometry plus a lockstep rotation LFO, the Vocoder's band bank now runs four bands per `f32x4` lane, and the Vaporisateur skips redundant `exp2` work through a shared `dsp::fast_math` that has a byte-identical `lib-dsp/fast-math.ts` twin so parity survives. Vocoder.odb rendered 49.9 to 40.1 ms, Nite 79.3 to about 67 ms. Done.
- The "Open Up" vocal that played in WASM but not in TS. Not a routing bug: the wasm note path simply ignored a note's `chance`, `playCount`, and `playCurve`, so a probability-gated vocal always sounded. Ported the fields and the exact `Mulberry32(0xFFF_F123)` roll stream the TS sequencer draws per note, so the dice fall identically in both engines. Done.
- NeuralAmp (the Tone3000 / NAM amp modeler) plays in the WASM engine. Decision first: NOT a Rust port of
  NeuralAmpModelerCore. The engine BRIDGES to the exact `@opendaw/nam-wasm` module (v1.2.0 = core 0.5.3, the
  latest A2-capable release) the TS engine runs, instantiated as its own wasm instance in the worklet — an
  Emscripten build cannot join the engine's shared memory — with a `host_nam_*` closure family in the script
  bridge's mold, one JS hop and two 128-sample copies per chunk, negligible next to the inference. Parity with
  the TS engine is by construction: a level null-test through the same WaveNet model lands within 0.05 dB.
  See `neural-amp.md`. Done.
- The model delivery needed no blob handshake at all: Tone3000 already copies the chosen `.nam` JSON into a
  content-addressed `NeuralAmpModelBox` STRING field, and that box was already in the wasm registry — the JSON
  arrives in the engine's own box graph with every sync. A new GENERIC observation closes the last gap:
  `observe_target_string(path, field_key)` tracks a device's POINTER field and delivers the TARGET box's string
  through the existing `field_changed` wire (empty = unbound), sharing the `FIELD_OBS` id space (entries grew a
  `target_key`, 0 = plain). The device hands the delivered ptr/len straight to the bridge, which copies the raw
  UTF-8 into the nam heap — no JS string, no TextDecoder (the worklet has none), byte-identical re-deliveries
  skipped. The nam module itself loads LAZILY on the first model, its binary fetched over a new `nam` RPC
  channel (the TS engine's `fetchNamWasm` recipe); until it lands the device passes through, exactly like the
  TS processor mid-fetch. Bridges are keyed by device uuid so a rebind reuses the loaded (prewarmed) model.
- `device-neural-amp` mirrors the TS processor's wrapper to the letter: input/output gain `decibel(-72, 0, 12)`
  through `db_to_gain`, unipolar mix, `mono` as an observed bool field driving instance count (mono averages
  L+R into one instance, stereo runs two), not-ready = plain passthrough (no gains, no mix), `reset` resets the
  nam instances. Native tests prove the wrapper (mappings, field dispatch, stub passthrough); WASM wiring tests
  prove a WaveNet model audibly reshapes the signal, LSTM and stereo run finite, and an unbound model is a
  bit-exact passthrough. The test-side TS renderer also gained a real `fetchNamWasm`, so parity patches may
  carry NeuralAmp devices. Known gap, shared with the script bridge: devices have no `terminate` export, so a
  REMOVED device leaks its two nam instances until reload. Done. Only the Modular device remains unported.

## Day 16 (2026-07-04): a cleanup batch, live meters over the real LiveStream, and a sample-handle heap leak fix

- A second engine-wide review (clean code and performance this time), its findings fixed in order under one
  hard invariant, the Vocoder.odb render fingerprint stayed byte-stable through the whole batch. An aux send
  now DETACHES its input when the source chain tears down (it kept summing the last frozen buffer into its bus
  forever), the value-event collections gained an `ExactEq` insert-after-equal-run plus a cached max duration,
  the tape player pre-warms its stretch-sequencer pool at reconcile so region entry never allocates mid-render,
  the worklet's silent failure paths (a rejected transaction, a failed sample decode) now report over the
  script back-channel instead of desyncing quietly, and the three parallel wasm loaders (worklet, node tests,
  perf worker) were folded into one `device-linker.ts` with a single `HOST_IMPORTS` list, which immediately
  surfaced a real COMPOSITES drift between them. The unit reconcile also split `params_dirty` from
  `automation_dirty`, so a joiner's parameter catch-up can no longer re-push every surviving plugin's
  parameters (which would, e.g., glide a delay's offset). Done.
- Live telemetry, the LiveStreamBroadcaster plan's phases 1 and 2 plus more. The lib-fusion protocol is NOT
  ported: the JS broadcaster and receiver stay byte-untouched, and the worklet registers packages whose
  Float32Array views point straight into wasm memory (shared-memory views survive talc growth), so the render
  path copies nothing. Engine-side, a broadcast table (`broadcast.rs`) registers meter slots at reconcile and
  self-heals by sweeping `Weak` owners, bumping a generation the worklet diffs to re-register its packages.
  `meter.rs` ports the TS `PeakBroadcaster` (250 ms peak decay applied as base^samples, 100 ms RMS ring), and
  meters landed in every instrument, audio effect, channel strip, and the tape player, under the SAME addresses
  the studio subscribes (device uuid, unit uuid, `EngineAddresses.PEAKS` for the master). A new `/live-meters`
  page loads any project or bundle and shows one row per audio unit, one column per device, with note-activity
  dots for the midi side. Two lessons: `UUID.Lowest` is NOT all zeros (version and variant bits at bytes 6 and
  8), a hardcoded `[0u8; 16]` made the master strip silently unsubscribable until it became a `WASM CONTRACT`
  constant, and note activity deliberately deviates from TS (a monotonic counter instead of the 128-bit `Bits`
  set), which is recorded in the plan. Done, phases 3 to 5 (parameter values, device telemetry, spectra) open.
- A heap detective story. Scrubbing the sync log forward and back crept `heap_used` upward, about a kilobyte
  per cycle but only SOMETIMES, and the pattern was the tell: growth landed only at power-of-two cycle counts
  with each jump twice the last (704, 1408, 2816, 5632, 11264 bytes), which is a `Vec` whose content grows
  linearly while only its capacity doublings show. A deterministic probe reproduced the user's exact numbers,
  a `debug_probe` export dumped every container count (all flat), a stash bisect proved the leak predated the
  day's work, and the culprit was the sample slot table: freed slots were tombstoned (`None`, index never
  reused) so every rewind-and-replay cycle of the 16 AudioFileBoxes appended 16 dead slots forever. The fix
  keeps the stale-handle safety but recycles slots: handles are now generation-tagged (`generation << 16 |
  index`, 15-bit generation so the i32 crossing to JS stays positive), `free` bumps the generation and
  recycles the index, and a stale device handle resolves to `None` by generation mismatch instead of by
  tombstone. Soundfonts got the identical treatment. The probe now reads 7648.8 KB flat across 20 cycles and
  stays in the suite as a regression test. Done.

## Day 17 (2026-07-05): a production-readiness audit, the last feature ports, and a per-block automation fix

- A full production-readiness pass over the engine, its findings fixed in one batch. Panic messages were
  INVISIBLE in production (panic=abort strips them, a trap surfaces as an anonymous "unreachable"): the handler
  now deposits the real message + location into a static `PANIC_MESSAGE` buffer, exported through
  `panic_message_ptr/len`, and every device shares `abi::panic_to_host`; the worklet reads it back and attaches
  it to the error. The worklet lacks TextDecoder, so a hand-rolled `utf8.ts` decodes the buffer, and a grep
  guard test greps every worklet-reachable tree for `new TextDecoder` (node vitest can't catch this class of
  gap). The EventBuffer's `clear()` was the one systematic render-path allocation — it now empties buckets
  KEEPING their storage. A CI guard renders 162 automatable parameters across 20 devices and asserts the wasm
  value-mappings match each TS `*BoxAdapter` (zero mismatches, but the guard stays). The worklet message
  handlers got failure guards (a thrown handler no longer wedges the audio thread silently), the sync path
  serializes at emission time with a real checksum round-trip, and freeze survived a reboot (replay + off-audio
  -thread PCM staging). A PeakMeter NaN was a use-after-free: after a chain teardown the broadcast queue served
  freed meter-slot pointers, fixed with `queue.clear()` + a `BroadcastEntry::alive()` gate. Done.
- The remaining feature gaps, ported to close the list. Markers, the signature track, and metronome preferences
  (enabled / gain / beat-subdivision / monophonic, plus custom click samples) all landed engine-side. Base
  frequency is now PULLED from the host (`host_base_frequency`) rather than hardcoded. MIDIOutput is an
  engine-side recorder like the tape, not a plugin — it writes `[device][status][data1][data2][length][timeMs]`
  records drained over a lock-free SAB ring with a null-payload postMessage wakeup (the studio's existing fast
  path), and the same hunt fixed a TS bug where the MIDIOutput device never owned a NoteBroadcaster, so its
  note indicators were dead in BOTH engines. Zeitgeist's swing was hardcoded 0.65 and now reads the groove.
  Composite CELL sequencers got live note signals. Devices gained a `terminate` export so a removed
  NeuralAmp/script device releases its JS-side bridge instead of leaking to reload. Loop gating while recording,
  `truncateNotesAtRegionEnd`, and DSP-load stats (an HRClock over a Worker+SAB, since the worklet has no
  `performance.now`) all mirror their TS preferences. Done, the feature-gap list is empty.
- A per-block automation hunt on indahouse.od (user: "very different after the first kick"). Two symptoms, two
  causes. Automation executed on the engine even while PAUSED — the update clock now gates on
  `BlockFlag.transporting` exactly like TS `UpdateClock`. And every OTHER kick jumped to +14 dB: the Playfield
  `SlotVoice` wrote its FINAL sample before returning, so a mono retrigger on a voice whose release had already
  run squared a hugely negative release term into a ~7x one-sample spike, which the master Maximizer clamped,
  ducking the whole mix. TS returns BEFORE that write; the voice now mirrors it. A committed
  `indahouse-ts-vs-wasm.test.ts` pins it to a hard per-second tolerance. Done.
- `audio_unit.rs` had grown past 5800 lines. Split into six modules (types+lifecycle, wiring, routing, tracks,
  params, tests) as pure code motion, re-exported so no call site changed. Done.

## Day 18 (2026-07-06): the WASM engine becomes the default, an SDK package, and a mono-voicing click

- The WASM engine is now the DEFAULT everywhere. `isEnabled()` reads localStorage `!== "false"`, so only an
  explicit opt-out selects TS; a boot with missing artifacts falls back for the SESSION only (persisting the
  opt-out would strand the user on TS after the artifacts return). The header toggle reflects the EFFECTIVE
  state (enabled AND ready) and stays gated to localhost + dev, so production users have no path back to TS,
  which matches trashing it later. wasm-opt now actually runs: `brew`/`apt` binaryen in both deploy workflows,
  and testing it locally exposed that it had been ABORTING all along on `i32.trunc_sat` — `build-wasm.sh` was
  missing four feature flags Rust >= 1.82 emits by default (nontrapping-float-to-int, sign-ext, multivalue,
  reference-types). With those added the engine shrank 548 to 483 KB, plugins 348 to 304 KB, suite green on the
  optimised modules. Done.
- SDK packaging: `@opendaw/studio-core-wasm`, a published sibling to `studio-core`. Its dist ships the
  main-thread API (`index.js`), two prebuilt esbuild bundles (`wasm-processor.js` + `wasm-offline-worker.js`,
  the worklet-scope shim guaranteed first), and the binaries (`wasm/engine.wasm` + `wasm/plugins/*.wasm`, built
  by the package's own `build-wasm.sh`). `WasmEngine.install({processorUrl, offlineWorkerUrl, wasmUrl})` takes
  host-served URLs — no relative source imports, no studio-app code. The shared plumbing (engine-modules,
  device-linker, the script/NAM bridges, sync, utf8, scope shim) moved OUT of `app/wasm/src` and the studio's
  `src/wasm-engine`; the studio consumes the published surface (`?url` asset imports + a vite plugin copying
  dist), while `app/wasm` stays the dev harness and deep-imports the package SRC so the Rust loop never sees a
  stale dist. One deviation from the plan: no `plugins.json` manifest — the device table stays compiled-in TS,
  with a `dist-smoke.test.ts` that fails the build if the table and the built plugins drift (plus dist-only
  resolution, shim-before-registerProcessor, engine compile). A turbo `dependsOn` was needed or the two builds
  race cargo and the shared dist. Done. Only capability-gated auto-fallback stays deliberately unbuilt (the TS
  engine is being retired, not kept as a runtime safety net).
- A mono-voicing click (user: env-bug.od clicks on overlapping notes, mono vapo, gone in poly or at 30 bpm; and
  a SECOND project clicks with no arp at all). The dual-engine null render showed wasm cutting to exactly 0.0
  mid-waveform where TS stayed continuous — two independent causes, both needed. The arpeggio sorted note-OFF
  before note-ON at an equal pulse; TS yields the step's ONs first, which is what keeps a mono synth legato
  across abutting steps (the held stack still contains the previous note, so the voice glides instead of
  retriggering). `lifecycle_rank` now ranks ON first. The GENERAL cause, the one that clicks with no arp:
  `MonophonicStrategy` owned ONE voice, so a retrigger while the voice was still releasing ran `force_stop()`
  then `start()` on the SAME object — force_stop snaps the ADSR to 0.0 and start resets the envelope, the VCA
  smoother and the oscillator phase, a hard cut mid-waveform (measured -0.105 to 0.0 in one sample, an ~18-frame
  notch the Maximizer made audible). TS spawns a fresh voice per retrigger and fades the old one out in
  `#processing`; the strategy now holds a small pool mirroring `#triggered`/`#sounding`/`#processing`, so the
  outgoing voice fades on its own slot over the ~3 ms smoother and the new note starts clean. The invariant, per
  the user: a synth voice must NEVER be reset while still audible; the only hard cut left is genuine pool
  exhaustion. `env-bug-ts-vs-wasm.test.ts` pins both, its single-sample cap (0.01) is the real click detector
  since an 18-frame notch barely moves RMS. Done.

## Day 19 (2026-07-07): recording crash fix, video export bounds, SIMD gate, compressor and fast-math perf

- A recording-pause crash, memory access out of bounds (user hint: "creating a sample breaks the memory"). A
  RecordAudio box churn bumps the sample handle's generation, so `sample_allocate` returns 0 for the now-dead
  handle, and `boot.ts` was writing the decoded PCM at address 0, straight through the wasm heap base. The
  sample and soundfont delivery paths now return on a 0 pointer instead of writing, and the freeze path in
  `processor.ts` guards the same way. A committed `boot-dead-handle-guard.test.ts` pins it. Done.
- A video export that rendered forever showing "Waiting for silence" (test-files/video.od). It is a Spielwerk
  generating notes without end, so the render never falls silent and only stopped at the one-hour safety cap.
  `VideoRenderer` now bounds the tail after the last region (RENDER_TAIL_SECONDS 12) and fades the audio out
  over FADE_OUT_SECONDS 4, so an endless generator terminates cleanly. The same file had a blank shadertoy
  spectrum because the offline render path never broadcast it, the offline worker now runs a `LiveStreamBroadcaster`
  plus an `AudioAnalyser` feeding the same SPECTRUM/WAVEFORM `EngineAddresses` the live worklet uses, so the
  shader gets its FFT per quantum in an export too. Done.
- `testFeatures` now gates on SIMD. The WASM engine is the default with no TS fallback, so an unsupported
  browser must fail loudly at boot, `features.ts` validates a minimal `v128` module through `WebAssembly.validate`
  and throws "WebAssembly SIMD is required" rather than booting into a silent-render dead end. Done.
- The compressor's per-sample dB conversions moved off libm `pow`/`log` onto the shared fast math.
  `dsp::ctagdrc` `gain_to_decibels` / `decibels_to_gain` use `fast_log2` / `fast_exp2` with the LOG10_2 / LOG2_10
  literals, mirrored in `lib-dsp` `conversation.ts`, so both engines stay bit-identical. A lesson from the user
  worth keeping: I first mirrored BOTH engines to the fast pair and "verified" by comparing them, which is
  comparing two new functions, not the new way against the old. The real proof is an ABSOLUTE accuracy test
  against the exact math, `fast_log2` versus libm `log2` is 1.46e-9, and the compressor's dB path versus the
  exact `Math` result is 8.8e-9 dB, below -160 dBFS and under the f32 floor. On `/performance` the Compressor
  dropped 3.612 to 2.401 us/quantum, about a third off. Done.
- A fast-math performance pass, measured end to end. First Tidal: I put its per-sample `pow` on the same fast
  pair, and `/performance` said it REGRESSED, wasm 3.974 against 3.355 on libm, so I reverted it. The root cause
  is instructive, `fast_exp2` built its power-of-two scale with a repeated-multiply LOOP up to 64 steps, and
  Tidal feeds it large exponents (`p_ex * log2(base)`, very negative near the trough), so the loop dominated.
  To see this straight I added the perf-comparison benchmarks the diary had been missing, a `fast_math::perf`
  module timing each fast function against its libm twin (ignored by default, release-only). `sin_tau` 1.95x and
  `log2` 1.68x are genuine wins, but `exp2` was 0.17 to 0.26x, a 4-6x LOSS, entirely that loop. So I rewrote the
  scale as a constant-time IEEE-754 exponent bit-set, `f64::from_bits(((steps + 1023) as u64) << 52)` in Rust
  and the mirrored `Uint32`/`Float64` view in TS, the exact same `2^steps` the loop produced (0 mismatches over
  the full range, every accuracy and edge test unchanged) but flat across magnitude, native 4.45 ns and twice
  the loop's speed. On wasm it showed no measurable device win, `exp2` is not a bottleneck in any current device
  and the change sits under the run-to-run noise, but it is kept as a zero-risk removal of the loop cliff that
  sank Tidal, so no future device feeding it large `|x|` can hit that pathology. Tidal stays on libm, and I did
  not re-attempt the fast pair there since the expected gain is now below the measurement noise and it would
  trade libm's ~1e-13 accuracy for the fast pair's ~1e-7 for nothing provable. Done.
