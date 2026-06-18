# Device and Engine Interface (WASM)

Status: proposal. This is the foundation for every device the engine hosts, present and future. It
defines what a device needs from the engine, how it gets timeline data, and a single small interface
(an ABI plus a host capability table) that serves MIDI effects, instruments, audio effects, sidechain,
the composite Playfield, and the timeline reading TapeDevice. It is derived from a full read of the TS
`packages/studio/core-processors` engine and reconciled with the current Rust `abi` and `engine-env`.

## 0. The one principle

The engine (host) owns everything stateful and shared. A device is a black box wasm plugin the host
calls once per quantum, handed a `ProcessInfo` (the block array) over the `abi` descriptor. The device
decides for itself whether to honour the block boundaries. Concretely the host owns:

- the box-graph mirror: the worklet-side copy of the project, synced from the main thread by the
  `SyncSource`, from which the host reads all structure (both the timeline and each device's own box),
- the timeline: tracks holding clips and regions (data in the box graph). It only references samples, it
  does not hold sample data,
- sequencing: the playback logic that reads the timeline against the transport and yields the per-range
  note-event and audio-region stream (loops, clip launching, region iteration). This is engine behavior,
  not a property of the timeline,
- the sample resource: decoded audio frames in the shared linear memory, addressable by sample handle,
  serving sample references whether they come from a timeline region or directly from a device's own box,
- the processor graph and its topological order (the single flat graph, required by sidechain),
- the transport and the per-quantum blocks,
- the audio buffers, which live in the one shared linear memory,
- automation evaluation (the value-event curves and `valueAt`).

A device never reaches into the box graph, never owns a buffer, never evaluates an automation curve, and
never decides processing order. It receives resolved inputs and writes outputs. This keeps devices small,
safe, language-enforced, and identical whether first-party or third-party.

This splits cleanly into two layers:

- Host layer (`engine-env` + engine): Rust traits and graph nodes. `EngineContext`, `Processor`,
  `NoteSequencer`, `AudioBusProcessor`, `AudioOutputBufferRegistry`. These already exist. The
  `AudioProcessor` block-splitting template also lives here, but in the device model it becomes an
  opt-in helper offered to device code, not something the host forces.
- Device ABI layer (`abi`): the wasm-to-wasm boundary. The descriptor plus a small host-import table.
  A host-side wrapper node (today `PluginInstrument`) bridges the two: it is the graph node, fills the
  descriptor, and calls the device's `process`.

Everything below is about what flows across that boundary.

## 1. Device taxonomy and what each needs

References are to `packages/studio/core-processors/src`.

| Device kind | Examples | Input | Output | Special need from engine |
|---|---|---|---|---|
| MIDI effect | Pitch, Velocity, Arpeggio, Zeitgeist, Spielwerk | note stream | note stream | active-notes query (arpeggio), transport flags, may generate |
| Instrument | Vaporisateur, Nano, Soundfont | note stream | audio | base frequency, ppqn, sample rate |
| Audio effect | Delay, Reverb, Crusher, Revamp | audio buffer | audio buffer | tempo for synced effects |
| Sidechain effect | Gate, Compressor, Vocoder | audio + a second audio buffer | audio | resolve a foreign output buffer and order it first |
| Composite instrument | Playfield | note stream | audio | host adds its inner voices and per-voice effect chains as ordinary nodes in the one flat graph |
| Timeline-audio instrument | TapeDevice | none (reads the timeline) | audio | enumerate all audio regions across all tracks of its unit; each region references a sample, resolved via the sample resource |
| Generative MIDI | Spielwerk, Zeitgeist | optional note stream | note stream | transport, optional note query |

The note stream, the audio buffers, and the parameters are the same three things for almost everyone.
The two outliers are sidechain (needs a foreign buffer) and Tape (needs to read the timeline directly).
Playfield is the only one that needs to host other processors.

## 2. The data routes

The user's framing is exactly right: parameter automation is a different route from note and audio data.
There are six distinct routes, and the interface is the union of them.

### Route A: notes (host pulls, device consumes)

TS: `NoteEventSource.processNotes(from, to, flags)` is a pull generator
(`NoteEventSource.ts:41`). `NoteSequencer` reads the unit's note tracks, regions, clips and loop cycles
(`NoteSequencer.ts:99-163`), `NoteEventInstrument` buffers and sorts the events and hands them to the
instrument (`NoteEventInstrument.ts:9-47`). MIDI effects sit between the sequencer and the instrument,
each both a source and a target (`MidiDeviceChain.ts:76-96`).

Rust today: this is already built host-side (`NoteSequencer`, `NoteEventInstrument`, `NoteRegionSource`,
`EventBuffer`). The host pulls notes, resolves each to a sample offset, and writes `EventRecord[]` into
the descriptor (`abi` words `[8] [9]`). Instruments already work this way (`PluginInstrument`).

Device ABI: instruments read `Ports.events`. MIDI effects additionally need to emit a note stream, so
they need an output-events port and the chain runs host-side (see Route E and the ABI in section 3).

### Route B: audio (shared buffers, host owns order)

TS: an effect reads its input via `setAudioSource(buffer)` and writes its `audioOutput` buffer
(`AudioEffectDeviceProcessor.ts:1-9`, `processing.ts:54,62`). A chain is a linked list of buffer
pointers, wired in series in `AudioDeviceChain.ts:173-179`. Audio routing is by buffer reference,
ordering is by graph edge, and the two are registered together.

Rust today: `AudioBuffer` lives in shared memory, `AudioBusProcessor` sums sources, `EngineContext`
holds the graph and the topological sort. The descriptor already carries inputs and outputs (`abi`
words `[1..4]`, `Inputs`, `Ports.output`).

Device ABI: an audio effect reads `Ports.inputs.get(0)` and writes `Ports.output`. The host wraps it in
a graph node, sets the input offset to the upstream buffer, registers the edge, and calls `process`.

### Route C: timeline query (device pulls tracks and regions)

This is the new, general capability the user asked for: a device can ask the engine for the audio and
note tracks of its audio unit over a time range. It generalizes two things the TS engine does ad hoc:

- NoteSequencer reading note regions (`NoteSequencer.ts:148-162`),
- TapeDevice enumerating every audio region across every track of the unit
  (`TapeDeviceProcessor.ts:47-72` subscribes to `audioUnitBoxAdapter().tracks`, then
  `#processBlock` at `104-200` iterates regions via `context.clipSequencing.iterate(trackUuid, p0, p1)`
  and reads each region's `file.getOrCreateLoader().data` as `AudioData`).

In our model the host owns the timeline (the tracks, clips and regions) and the sequencing that reads it,
so the device does not re-walk the box graph. Instead the device calls host-import query functions, scoped to the device's own audio unit (the
host knows the unit from the wrapper node). The host writes records into shared memory and returns a
count. Two queries cover all current devices:

- query note events in `[from, to)` across the unit's note tracks, returning `EventRecord[]` (already
  resolved and sample-offset). This is the same path the host uses internally for instruments, exposed
  for generative devices that want the raw stream.
- query audio regions overlapping `[from, to)` across the unit's audio tracks, returning
  `AudioRegionRecord[]` with each region's placement and play-mode fields plus a sample handle. The
  sample handle is resolved to frames through the sample resource (Route F), not through the timeline.

Most devices never call these. Instruments get notes pushed (Route A). Only Tape-like and generative
devices pull. The clip-vs-region resolution and loop-cycle math stay in the host
(`ClipSequencingAudioContext.ts`, `LoopableRegion`), so the device receives already-resolved sections.

The timeline is one source of sample references, not the only one. A device may carry its OWN sample
references in its box (Playfield pads, a sampler's key zones), unrelated to any timeline region. Those are
read by the host from the device box and resolved through the same sample resource (Route F). So sample
references and sample data are decoupled from the timeline entirely.

### Route D: parameter automation (different route, host evaluates)

TS, confirmed: automation is engine-managed and the device only reads a value. `bindParameter`
subscribes a parameter and, when an automation track is attached, connects the `UpdateClock` event
output into the processor's event input (`AbstractProcessor.ts:37-61`). `UpdateClock` emits update
events on a musical grid while transporting (`UpdateClock.ts:14-41`). `AudioProcessor.process` splits
the block at every event offset, converts ppqn to a sample index, and calls `updateParameters(position)`
between sub-blocks (`AudioProcessor.ts:15-51`). `updateParameters` calls `parameter.updateAutomation`,
which evaluates the curve via `adapter.valueAt(position)` and fires `parameterChanged` only on change
(`AbstractProcessor.ts:63-69`, `AutomatableParameterFieldAdapter.ts:154-163`). During `processAudio` the
device just reads `parameter.getValue()` (`ChannelStripProcessor.ts`). The device has no visibility into
curves, events, or splitting.

Our model keeps curve evaluation in the host and keeps the device free to ignore granularity. The host
owns the value-event curves (the Rust `ValueCollection` already exists). The device is called once per
quantum with the full `ProcessInfo`, so the host does NOT split on its behalf. Instead the host:

- writes each automated parameter's value at the quantum start into the descriptor's params
  (`abi` words `[5] [6]`), and
- emits resolved param-update events (parameter index, new value, sample offset) into the device's event
  stream for sample-accurate changes within the quantum.

A device that does not care about sub-sample-accurate automation just reads `Ports.params[i]` once. A
device that wants sample accuracy uses the opt-in block-splitting template (a device-SDK helper mirroring
`engine-env::AudioProcessor`), which walks the param-update events and keeps the params current as it
fragments the quantum. Either way the device never evaluates a curve and never touches an automation
track. The carrier for param-update events (a distinct `EventRecord` kind versus a separate automation
port) is a detail to finalize.

This is the divergence the user named. Notes and audio regions come from the timeline through sequencers
and region readers (Routes A and C). Parameter values come through this separate evaluate-and-deliver
route (Route D). They meet only at the descriptor, as `events` versus `params`.

### Route E: routing and sidechain (device declares, host resolves and orders)

TS: a Gate, Compressor, or Vocoder resolves its sidechain pointer to a box address, looks that address up
in the global `AudioOutputBufferRegistry`, takes the source buffer, and registers an edge so the source
runs first (`GateDeviceProcessor.ts:86-100`, `AudioOutputBufferRegistry.ts:12-27`,
`CompressorDeviceProcessor.ts:144-148`, `VocoderDeviceProcessor.ts:103-108`). This is why the whole
project must be one flat graph: a sidechain edge can cross unit boundaries, and only a single global
topological sort can order arbitrary cross-unit dependencies without cycles. Aux sends are the same
shape, tapping a buffer and adding two edges (`AuxSendProcessor.ts`, `AudioDeviceChain.ts:193-199`).

Our model: the device never resolves pointers or buffers. The host wrapper resolves the sidechain target
through the existing `AudioOutputBufferRegistry`, registers the ordering edge, and passes the resolved
source as a second input in the descriptor (`Ports.inputs.get(1)`). The device declares once, in its
manifest, that it has a sidechain input. So sidechain reduces to an extra input the host fills, plus a
host-side edge. No new device-facing concept beyond a second input.

### Route F: samples (a resource, not the timeline)

Sample data is not timeline data. The timeline only references samples (an audio region points at a
sample), and a device may hold its OWN sample references in its box (Playfield pads, a sampler's key
zones) with no timeline involved. So sample references and sample data are decoupled from the timeline,
and the engine exposes them as a separate resource.

TS: audio is decoded on the main thread and reaches the worklet as `AudioData` (`{frames, numberOfFrames,
sampleRate}`) via `SampleManagerWorklet` and `engineToClient.fetchAudio`
(`SampleManagerWorklet.ts:26-46`). A region or device adapter resolves its reference to that data
(`file.getOrCreateLoader().data`).

Our model: a device cannot read a foreign SAB, so the main thread writes decoded frames INTO the one
shared linear memory (this is already a project rule). The engine exposes a sample resource keyed by
sample handle: given a handle, return the frames in shared memory (offset, frame count, channel count,
sample rate), or absent if not yet resident. Loading is asynchronous and host-managed via the existing
`await_resource` path. The host uses this resource for both reference sources:

- timeline-referenced samples: when answering the audio-region query (Route C), the host resolves each
  region's sample handle and includes the frames offset in the record (or marks it not-yet-resident, in
  which case the region is omitted that block, exactly as TS bails on `data.isEmpty()`).
- device-referenced samples: the host reads a device's own sample handles from its box (the box-graph
  mirror), resolves them, and hands the device a slot table of resident samples, refreshed on box edits
  and on load completion.

Either way the device reads sample frames from shared memory by offset and never decodes, loads, or
touches a file. Sample handles, not file paths or buffers, are the device-facing currency.

## 3. The proposed device ABI

The current descriptor already covers instruments and simple audio effects. Three additions cover MIDI
effects, automation, and the full `ProcessInfo`. The descriptor stays a flat `u32[]` of byte offsets into
shared memory, and `process` is called once per quantum.

Descriptor (extends the current `abi` layout):

```
[0]  frames                          // render quantum length (buffer length), e.g. 128
[1]  in_count    [2] in_offsets_ptr  // input[0] = main, input[1] = sidechain (by manifest)
[3]  out_count   [4] out_offsets_ptr
[5]  param_count [6] params_ptr      // values at quantum start; refined by param-update events (Route D)
[7]  state_ptr                       // stable per device instance, talc-allocated by the host
[8]  event_count [9] events_ptr      // input note events (Route A) + param-update events, sample-offset
[10] out_event_cap [11] out_events_ptr   // NEW: host-allocated buffer for produced notes (MIDI fx)
[12] block_count   [13] blocks_ptr       // NEW: the ProcessInfo -> Block[]
```

`Block` (the `ProcessInfo` element, mirroring `engine-env::Block`):

```
index:u32  p0:f64  p1:f64  s0:u32  s1:u32  bpm:f32  flags:u32
```

The device receives all blocks for the quantum and may process the whole `[0, frames)` ignoring them, or
walk them (and the events, which carry block index plus sample offset) for sample accuracy. `sample_rate`
is set once at `init` and is not repeated per quantum. `process` returns the number of `EventRecord`s the
device wrote to `out_events_ptr` (0 for instruments and audio effects). MIDI effects read `events`, write
`out_events`, return the count.

Host import table (the device's view of the engine; a small set of functions the host provides at
instantiation, callable during `process`). All pointers are byte offsets into shared memory.

```
// Timeline query (Route C), scoped to the calling device's audio unit.
host_query_note_events(from_lo:u32, from_hi:u32, to_lo:u32, to_hi:u32, out_ptr:u32, max:u32) -> u32
host_query_audio_regions(from_lo:u32, from_hi:u32, to_lo:u32, to_hi:u32, out_ptr:u32, max:u32) -> u32
// Sample resource (Route F): resolve a sample handle to resident frames; 1 if resident, 0 if not.
host_resolve_sample(handle:u32, out_ptr:u32) -> u32   // out_ptr -> SampleRef
// (f64 ppqn passed as two u32 words; or via a small in-memory query struct, to finalize.)
```

`SampleRef` (Route F): `frames_ptr:u32  frame_count:u32  channel_count:u32  sample_rate:f32`.

`AudioRegionRecord` (shape, fields to finalize against the box schema):

```
sample_handle:u32     // the sample reference; resolve via Route F (host has resolved it for this record)
frames_ptr:u32        // -> f32 frames in shared memory, 0 if not yet resident (region omitted that block)
frame_count:u32  channel_count:u32  sample_rate:f32
region_position:f64  region_duration:f64  loop_offset:f64  loop_duration:f64
file_offset_seconds:f32  gain:f32
// time-stretch: warp/transient handle or a flag; phase 2
```

What is deliberately NOT in the ABI: pointer resolution, edge registration, automation curves, clip vs
region logic, loop math. Those stay host-side. The device sees resolved inputs, resolved params, resolved
events, resolved region records.

## 4. Host-side EngineContext and the per-category bridges

`engine-env::EngineContext` already has `register_processor`, `register_edge`,
`subscribe_process_phase`, the `AudioOutputBufferRegistry`, and `process`. Two capabilities must be added
to support Routes C and E end to end:

- a timeline-query facade the host wrappers use to answer `host_query_*` (note events and audio regions
  for a given audio unit and range). This wraps the existing sequencing and region reading.
- a sidechain resolver: given a device's sidechain target box address, return the registry entry
  (buffer plus producing node) so the wrapper can set input[1] and register the edge. The registry
  already exists, this is the lookup plus edge.

The bridges are host-side graph nodes, each implementing `Processor`, each wrapping one device instance.
They fill the descriptor (blocks, events, param-update events, params) and call `process` once per
quantum. They do not split on the device's behalf.

- `PluginInstrument` (exists): pulls notes, fills events and the blocks array, fills params and
  param-update events, calls `process`, fans device output into its `AudioBuffer`.
- `PluginAudioEffect` (new): sets input[0] from the upstream buffer, fills params and automation, calls
  `process`, exposes its `audioOutput`. If the manifest declares a sidechain, resolves input[1] and edges.
- `PluginMidiEffect` (new): a `NoteEventSource` in the host chain. On pull, it runs upstream into an
  input `EventRecord[]`, calls `process`, reads back the produced `EventRecord[]`, yields them.
- `CompositeDevice` (new, for Playfield): see section 5.

Because the host wrappers are the graph nodes, the single flat graph and its topological sort are
unchanged. Sidechain, aux sends, and Playfield's internal edges are all just edges between host nodes.

## 5. Composite devices (Playfield)

TS Playfield: `incoming` is a `PlayfieldSequencer`, `outgoing` is a `MixProcessor`, and between them sit N
`SampleProcessor`s, each with its OWN `InsertReturnAudioChain`, all registered into the same engine graph
via `context.registerEdge` (`PlayfieldDeviceProcessor.ts:27-76`, `SampleProcessor.ts:27-63`). The nested
effects are ordinary, runtime-editable audio-effect devices: the user adds, removes, and reorders them
while the project runs. They cannot be baked into a Playfield binary, and the set is not known ahead of
time.

So a composite is necessarily host-expanded, and there is NO nested or contained graph. The host wrapper
creates the composite's internal processors as ordinary nodes in the one flat graph, peers of every other
node, and rewires them on box-graph edits. For Playfield that is, per pad: a sample-voice plugin node
feeding its per-pad effect-plugin chain into the Playfield mix bus (an `AudioBusProcessor`), with the
sequencer routing each note to the pad that matches it. Every inner effect is the same `PluginAudioEffect`
wrapper used at the top level, every connection is a `register_edge` in the one flat graph, and rewiring
uses the existing `ProcessPhase::Before` hook.

It must be the one flat graph, not a contained subgraph, for the same reason as Route E: a Playfield pad's
audio effect can have a sidechain on another audio unit's output, so that foreign producer must be ordered
BEFORE this inner effect. Only the single global topological sort can order a node living inside Playfield
against a node in a different unit. A contained subgraph could not express that cross-cutting edge. So
Playfield's inner nodes are not walled off, they are peers of every other node, and the global sort orders
the whole thing at once.

Consequences:

- The device ABI does not change and gains no composite concept. "Composite" describes only how the host
  builds and maintains a cluster of nodes from the box, never a boundary in the graph.
- The only Playfield-specific DSP unit is the sample-voice plugin (sample playback, pitch, envelope per
  pad). The grouping, ordering, and mix are host graph wiring, reused wholesale from the audio-unit chain.
- A composite therefore depends on the effect-plugin path (Routes B and E) being in place first. It is the
  last thing built, not the first.
- The manifest marks a device as composite so the host knows to create the inner nodes rather than a
  single node, and where to read the pads and their inner effect lists from the box.

## 6. Requirements checklist (what the engine must provide)

Per route, the complete set a device can rely on:

- Transport and time: `frames`, `p0`, `p1`, `bpm`, `flags` (transporting, playing, discontinuous,
  bpm-changed), and ppqn. Delivered as the per-block fields of the `ProcessInfo` blocks array.
  `sample_rate` is set once at `init`.
- Notes in: resolved, sorted, sample-offset `EventRecord[]` for the quantum, each tagged with block
  index (instruments, MIDI fx).
- Notes out: a host buffer to write produced `EventRecord[]` and a return count (MIDI fx, generative).
- Audio in: one or more input buffers by offset, input[1] reserved for sidechain by manifest.
- Audio out: the output buffer(s) by offset.
- Params: automation-evaluated values at quantum start plus param-update events for sample accuracy,
  host-filled (Route D). The device declares its parameter list and order in its manifest.
- Active-notes query: needed by arpeggiator-style devices to read held notes at a position. Provide via
  the note query, or by also passing the active set. To finalize.
- Timeline query: note events and audio regions across the unit's tracks for a range (Route C), scoped
  to the device's unit, with clip and loop resolution done host-side.
- Sample resource (Route F): resolve a sample handle to resident frames in shared memory, by offset,
  serving both timeline-region references (Tape) and a device's own box sample references (Playfield,
  sampler). Async load is host-managed; not-yet-resident samples resolve as absent.
- Routing: the host resolves sidechain and aux targets through the `AudioOutputBufferRegistry` and
  registers the edges. The device only declares the dependency in its manifest.
- Identity and scoping: the host knows each device's audio unit and box address, so all queries and
  registry entries are correctly scoped without the device passing identifiers.
- Instance state: a stable, host-allocated (talc) state block per instance, zeroed once, reused across
  calls. Already in place.
- Base frequency: for pitch to frequency mapping in instruments. Session-level, via the engine.

Device manifest (declared once per device, drives the host wrapper): kind (midi effect, instrument,
audio effect, composite), parameter list and order, whether it has a sidechain input, whether it reads
the timeline (and which track kinds), input and output channel counts, state size.

## 7. Phasing

1. Generalize the existing instrument bridge into `PluginAudioEffect` and `PluginMidiEffect`, add the
   descriptor's out-events and blocks-array words. Audio-effect and MIDI-effect plugins become possible.
2. Deliver automation (Route D): the host evaluates the value-event curves it already owns, fills params
   at quantum start, and emits param-update events. Provide the opt-in block-splitting template in the
   device SDK for devices that want sample-accurate automation.
3. Add the sidechain resolver and input[1] (Route E). Ship a Gate or Compressor plugin as proof.
4. Add the timeline query (Route C) and ship TapeDevice. This is where "query all audio and note tracks"
   lands.
5. Playfield as host-created plugin nodes in the one flat graph (per-pad sample-voice plugin into per-pad
   effect-plugin chain into a mix bus), after the effect-plugin path (Routes B and E) is proven.

## 8. Open decisions for review

- Active-notes query for arpeggiators: a dedicated query versus passing the active set in the descriptor.
- Param-update event carrier: a distinct `EventRecord` kind in the shared event stream versus a separate
  automation port in the descriptor.

Decided: the device is called once per quantum with the full `ProcessInfo` (the blocks array) and chooses
whether to respect blocks. Block splitting is an opt-in device-SDK template, never forced by the host.
- `AudioRegionRecord` exact layout and the time-stretch and transient fields, to finalize against the
  box schema when Tape is scheduled.

## References

TS spine: `EngineContext.ts`, `EngineProcessor.ts`, `processing.ts`, `AudioUnit.ts`,
`AudioDeviceChain.ts`, `MidiDeviceChain.ts`, `AudioProcessor.ts`, `AudioBusProcessor.ts`,
`AudioOutputBufferRegistry.ts`.
TS notes: `NoteEventSource.ts`, `NoteSequencer.ts`, `NoteEventInstrument.ts`, `MidiEffectProcessor.ts`,
`devices/midi-effects/*`.
TS audio and sidechain: `AudioEffectDeviceProcessor.ts`, `devices/audio-effects/GateDeviceProcessor.ts`,
`CompressorDeviceProcessor.ts`, `VocoderDeviceProcessor.ts`, `AuxSendProcessor.ts`.
TS composite and timeline audio: `devices/instruments/PlayfieldDeviceProcessor.ts`, `Playfield/*`,
`devices/instruments/TapeDeviceProcessor.ts`, `Tape/*`, `ClipSequencingAudioContext.ts`,
`SampleManagerWorklet.ts`.
TS automation: `AutomatableParameter.ts`, `AbstractProcessor.ts`, `UpdateClock.ts`,
`AutomatableParameterFieldAdapter.ts`.
Rust now: `crates/abi/src/lib.rs`, `crates/engine-env/src/*`, `crates/engine/src/lib.rs`
(`PluginInstrument`, `build_audio_graph`).

See also [[project_wasm_device_architecture]], [[project_wasm_audio_data_sab]],
[[project_wasm_frozen_contracts]].
