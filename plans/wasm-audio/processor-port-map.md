# Processor infrastructure: TS → Rust port map

TS is the implementation truth. This is the dependency-ordered list of the TS types that make up the
processor/graph infrastructure, each with its source file and where the Rust port lives. We port these
faithfully in structure rather than designing substitutes. Crate targets:

- **`engine-env`** = the single shared crate that folds everything reused by both the engine and
  devices (the `Event` model, PPQN, `AudioBuffer` / `Block`, the processor interfaces + bases + `Graph`,
  the `EngineContext` trait, the registry). The current `value` and `processors` crates and PPQN move in
  here, one crate for now.
- **`engine`** = host-only: the `EngineContext` impl, transport driving, bus / channel-strip / output,
  the device chains, and box-graph binding.
- **device crate** = one `cdylib` per device, depending only on `engine-env` + `dsp`.

## Port order

| # | TS source | What it is | Rust target |
|---|-----------|-----------|-------------|
| 1 | `lib/dsp/src/graph.ts` (`Graph`, `TopologicalSort`) | Ordering-only DAG: vertices + predecessor edges, topo sort with loop detection. No audio. | `engine-env` |
| 2 | `core-processors/src/processing.ts` (`Block`, `BlockFlag`, `Processor`, `AudioGenerator`, `AudioInput`, `EventReceiver`, `ProcessPhase`, `ProcessInfo`) | The core interfaces. `Block` is the render block. `Processor` = `process(ProcessInfo)` + `reset` + `eventInput`. `AudioGenerator` = `audioOutput`. `AudioInput` = `setAudioSource`. | `engine-env` |
| 3 | `EventBuffer`, `NoteEventSource.ts` (`NoteEventSource`, `NoteLifecycleEvent`), `AudioOutputBufferRegistry` | Per-block event queue; the pull-based note source; address → {buffer, producer} registry. | `engine-env` |
| 4 | `EngineContext.ts` | The handle every processor/device gets: `registerProcessor`, `registerEdge`, `subscribeProcessPhase`, `audioOutputBufferRegistry`, `getAudioUnit`, `updateClock`, `timeInfo`, `mixer`, `baseFrequency`. | trait in `engine-env`, impl in `engine` |
| 5 | `AbstractProcessor.ts`, `AudioProcessor.ts` | Base classes: parameter binding + the block/event sub-block split template (`process_audio` / `handle_event` hooks). | `engine-env` |
| 6 | `AudioBusProcessor.ts`, channel strip, the output/primary unit | Summing bus (`addAudioSource` list), gain/pan, the node whose `audioOutput` reaches the worklet. | `engine` |
| 7 | `AudioDeviceChain.ts`, `MidiDeviceChain.ts`, `InsertReturnAudioChain.ts` | Wire a unit's chain (instrument/midi-fx/audio-fx) by registering edges + buffer refs in `ProcessPhase.Before`. | `engine` |
| 8 | `AudioUnit.ts`, then a sine `Instrument` | The audio unit assembly, then the first device as its own crate. | `engine`, + `device-sine` |

Each step ends with tests before the next (per `08-port-order.md`).

## Audio routing is buffer references, not the graph

The graph (1) carries ordering only. Audio flows because each `AudioGenerator` owns its `audioOutput`,
a consumer holds a reference via `setAudioSource`, and a bus sums an `Array<AudioBuffer>` collected via
`addAudioSource` (`AudioBusProcessor.process`). A registered edge only means "run source before
target". Sidechain (Gate/Compressor/Vocoder) resolves its target address through the
`AudioOutputBufferRegistry` to get the source buffer to read, and `registerEdge(source, this.incoming)`
so the one global topsort runs it first. This is why there is exactly one graph (see
`device-processing.md`).

**Buffer-sharing model (decided).** A producer's `audioOutput` is a `SharedBuffer = Rc<RefCell<AudioBuffer>>`;
consumers hold cloned handles via `set_audio_source`, a bus keeps a `Vec<SharedBuffer>`. `Rc` (not
`Arc`, the engine is single-threaded), `RefCell` for in-place writes, no atomics, and clones happen only
at wiring time (never on the audio thread). It bridges to the device offset-ABI later by taking the
address of a host buffer's backing array and writing that offset into the descriptor, so host
processors and device wasm share the same bytes. The disconnect side replaces / rebuilds on re-wire, so
a `Terminable` port is deferred.

## Proposal: drop the `incoming` / `outgoing` accessor pair

**TS today:** `Processor` (via `DeviceProcessor`) exposes `incoming` and `outgoing`. For every simple
device they are both `this` (Soundfont, Nano, all audio effects, and even Playfield's internal `Mix` /
`Sample` processors). They differ in exactly one place: the composite wrapper
`PlayfieldDeviceProcessor`, where `incoming = sequencer` (note entry) and `outgoing = mix` (audio exit).
They are read in `registerEdge(source.outgoing, target.incoming)`, `registry.register(addr, buf,
this.outgoing)`, the sidechain `registerEdge(srcProc, this.incoming)`, and `reset()` of both.

**The idea (an intentional, requested deviation from TS).** The accessor pair only exists so a composite
can present a distinct entry node and exit node. But the registry **already** stores the exit node per
address (`register(addr, buffer, outgoing)`). So instead of exposing two processors on the public
interface, a device declares its **boundary ports once** when it registers with the engine handle:

- output/exit node (the producer) — already what the registry stores.
- input/entry node (note or audio) — defaults to the device itself; a composite passes its sequencer.

All wiring then connects **by address through the handle** (e.g. `context.connect(src_addr, dst_addr)`,
`context.connect_sidechain(src_addr, consumer)`), and the engine resolves the correct boundary nodes
from the registration. The `Processor` trait no longer carries public `incoming` / `outgoing`.

**Why this is reasonable, not reckless:** no information is lost (the entry/exit split still exists, now
held once in the engine registration instead of on every `Processor`), it removes a two-processor method
from the universal interface, and it matches "a device gets a handle to register specific things."

**Cost / risk to verify before committing:** every site that reads `incoming` / `outgoing` must be
re-expressed through the handle-by-address form and checked against TS so a case TS already handles is
not lost. Precisely:

- the three chain classes: `MidiDeviceChain` (`registerEdge(target, input.incoming)`),
  `AudioDeviceChain` (edges via `source.outgoing` / `target.incoming`, plus `incoming.reset()` /
  `outgoing.reset()`), and `InsertReturnAudioChain` (the reusable audio-fx chain, used at unit level and
  inside composite devices such as Playfield's per-pad chains).
- the per-device registry registration, which stores `this.outgoing` as the producer.
- every sidechain device (`Gate`, `Compressor`, `Vocoder` today, more later), each doing
  `registerEdge(sourceProcessor, this.incoming)`.

If any case resists the address form, fall back to the TS-faithful `incoming` / `outgoing` pair, which
is the safe default.

**Decision: adopt the handle-registration form (drop the pair).** This section stays as the record of
what TS does, so the fallback is one step away if a wiring case needs it.
