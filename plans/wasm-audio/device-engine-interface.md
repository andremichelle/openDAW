# Device and Engine Interface (WASM)

Status: APPROVED, NEXT TO IMPLEMENT. The phasing in section 7 is the agreed build order (start at step 1).
This is the foundation for every device the engine hosts, present and future. It defines what a device
needs from the engine, how it gets timeline data, and a single small interface (an ABI plus a host
capability table) that serves MIDI effects, instruments, audio effects, sidechain, the composite Playfield,
Bitwig-style container devices, and the timeline reading TapeDevice. It is derived from a full read of the
TS `packages/studio/core-processors` engine and reconciled with the current Rust `abi` and `engine-env`.

## 0. The one principle

The engine (host) owns everything stateful and shared. A device is a black box wasm plugin behind the
`abi` descriptor. An audio device is called once per quantum with a `ProcessInfo` (the block array) and
decides for itself whether to honour the block boundaries; a MIDI effect is instead PULLED on demand for a
time range (it produces no audio). Concretely the host owns:

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

A device never reaches into the box graph, never owns a buffer, never evaluates an automation curve, never
decides processing order, and never splits on another device's behalf. It reads its resolved inputs
(pulling its events) and writes its outputs. This keeps devices small, safe, language-enforced, and
identical whether first-party or third-party.

This splits cleanly into two layers:

- Host layer (`engine-env` + engine): Rust traits and graph nodes. `EngineContext`, `Processor`,
  `NoteSequencer`, `AudioBusProcessor`, `AudioOutputBufferRegistry`. These already exist. Block-splitting
  and event timing do NOT live here in the device model; they are device-side, packaged by a device-SDK
  template/macro (the `AudioProcessor`/`EventProcessor` analog). The engine never splits.
- Device ABI layer (`abi`): the wasm-to-wasm boundary. The descriptor plus a small host-import table.
  A host-side wrapper (today `PluginInstrument`) bridges the two: it is the host node, sets up the
  descriptor, and drives the device (calling `process` per quantum for audio devices, or answering pulls
  via `process_events` for MIDI fx).

Everything below is about what flows across that boundary.

## 1. Device taxonomy and what each needs

References are to `packages/studio/core-processors/src`.

| Device kind | Examples | Input | Output | Special need from engine |
|---|---|---|---|---|
| MIDI effect | Pitch, Velocity, Arpeggio, Zeitgeist, Spielwerk | note stream | note stream | active-notes query (arpeggio), transport flags, may generate |
| Instrument | Vaporisateur, Nano, Soundfont | note stream | audio | base frequency, ppqn, sample rate |
| Audio effect | Delay, Reverb, Crusher, Revamp | audio buffer | audio buffer | tempo for synced effects |
| Sidechain effect | Gate, Compressor, Vocoder | main audio plus one or more sidechain/aux buffers | audio | resolve each foreign output buffer and order it first |
| Composite instrument | Playfield | note stream | audio | host adds its inner voices and per-voice effect chains as ordinary nodes in the one flat graph |
| Timeline-audio instrument | TapeDevice | none (reads the timeline) | audio | enumerate all audio regions across all tracks of its unit; each region references a sample, resolved via the sample resource |
| Generative MIDI | Spielwerk | optional note stream | note stream | transport, optional note query (a MIDI fx that may ignore its input) |

The note stream, the audio buffers, and the parameters are the same three things for almost everyone.
The two outliers are sidechain (needs a foreign buffer) and Tape (needs to read the timeline directly).
Playfield and the container devices (section 5) are the ones that host other processors.

## 2. The data routes

The user's framing is exactly right: parameter automation is a different route from note and audio data.
There are six distinct routes, and the interface is the union of them.

### Route A: notes (device pulls, device times its own sub-blocks)

The engine must NOT pre-resolve an event array and hand it over, and it must NEVER split a block. Only the
processor knows what it does between events and how it advances time. This is the TS model: a
`NoteEventSource.processNotes(from, to, flags)` is a PULL generator (`NoteEventSource.ts:41`); the
processor's `AudioProcessor`/`EventProcessor` template fragments the block at event offsets itself,
calling `processAudio(chunk)` between events and `handleEvent(event)` at each offset
(`AudioProcessor.ts:15-51`, `NoteEventInstrument.ts:9-47`). The engine cannot do this for the device.

So the engine's job is only to RESOLVE events on demand. It owns `NoteSequencer` (reads the unit's note
tracks, regions, clips, loop cycles, `NoteSequencer.ts:99-163`) and the MIDI-fx chain (`MidiDeviceChain`),
and answers a pull: "give me the events in `[from, to)`". A device fetches its events through a host
import and then drives its own sub-block loop. `EventRecord` is just the flat wire record one such event
takes in shared memory; it is FETCHED, not pushed.

Device side: the device SDK offers TWO templates (a trait-default method or a macro), one per device shape,
so authors never reimplement timing:

- audio devices (instruments, audio fx) use the `AudioProcessor` analog. Per block it pulls the event
  stream (notes plus the param-update events of Route D, merged and offset-sorted), walks the sub-chunks at
  the offsets, and calls `process_audio(chunk)` between events plus `handle_event(event)` at each offset.
- MIDI effects use the `EventProcessor` analog and are themselves PULL SOURCES (no audio). The host routes
  a downstream pull for `[from, to)` into the device's `process_events(from, to)`. Inside, the device pulls
  its OWN upstream over whatever range it needs via `host_pull_events`, transforms or generates, and
  returns the events for `[from, to)`. The upstream range it requests need not equal `[from, to)`:
  Zeitgeist (time/groove warp) pulls upstream over `[unwarp(from), unwarp(to)]` and warps the result
  positions back into `[from, to)` (`ZeitgeistDeviceProcessor.processNotes` calls
  `source.processNotes(groove.unwarp(from), groove.unwarp(to))`). An arpeggiator steps time and queries
  held notes. There is NO per-quantum push of an out-events array; the output IS the pull response.

A device that does not care about sub-block accuracy processes the whole block and ignores the events.

CAVEAT (forward, monotonic pulls): the range a device requests upstream may differ from the range it
serves, but pulls must advance forward in time and not overlap or rewind. A STATEFUL upstream (an
arpeggiator holding retained notes, a sequencer tracking loop state) assumes time progresses forward and
cannot answer an out-of-order or rewound range correctly. Zeitgeist's warp stays monotonic within bounds,
so it is fine. A device that genuinely needs non-monotonic or random-access reads must pull from a
STATELESS source (the timeline query, Route C, which resolves any range), not from a stateful neighbour.
The host may assert monotonic progression per pull chain to catch violations.

Rust today (to migrate): `PluginInstrument` currently pre-pulls and pushes `EventRecord[]` in the
descriptor and the device fragments on it. That works but is the push model; it moves to the pull model
above so the engine stops delivering events.

### Route B: audio (shared buffers, host owns order)

TS: an effect reads its input via `setAudioSource(buffer)` and writes its `audioOutput` buffer
(`AudioEffectDeviceProcessor.ts:1-9`, `processing.ts:54,62`). A chain is a linked list of buffer
pointers, wired in series in `AudioDeviceChain.ts:173-179`. Audio routing is by buffer reference,
ordering is by graph edge, and the two are registered together.

Rust today: `AudioBuffer` lives in shared memory, `AudioBusProcessor` sums sources, `EngineContext`
holds the graph and the topological sort. The descriptor already carries inputs and outputs (`abi`
words `[1..4]`, `Inputs`, `Ports.output`).

Device ABI: an audio effect reads its input buffers (`Ports.inputs`) and writes its output buffer(s). The
host wraps it in a graph node, sets each input offset to its upstream buffer, registers the edges, and
calls `process`. Inputs and outputs are each plural sets, declared by the manifest (see Route E for
multi-input devices, and the ABI for multi-output devices and the single-kind output rule).

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

Most devices never call these. An instrument pulls its own notes (Route A); these timeline queries are
the broader pull for devices that read regions directly. The clip-vs-region resolution and loop-cycle math stay in the host
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

Our model keeps curve evaluation in the host and keeps the device free to ignore granularity, and it does
NOT push or split. The host owns the value-event curves (the Rust `ValueCollection` already exists) and:

- fills the descriptor's params (`abi` words `[5] [6]`) with each automated parameter's current value at
  quantum start. This is a state snapshot, the analog of TS `parameter.getValue()`, not a timed event.
- resolves param-update events (parameter index, new value, sample offset) that the device gets through
  the SAME pulled event stream as notes (Route A), merged and offset-sorted.

A device that does not care about sub-block accuracy just reads `Ports.params[i]` once. A device that
wants sample accuracy uses the device-SDK template, which fragments the block at the pulled events and
applies each param-update to keep the params current between sub-chunks. Either way the device never
evaluates a curve, never touches an automation track, and the engine never splits. The carrier for
param-update events (a distinct `EventRecord` kind versus a separate automation pull) is a detail to
finalize.

This is the divergence the user named. Notes come from the timeline through sequencing (Route A) and audio
regions through the timeline query (Route C). Parameter automation is a separate concern the host
evaluates (the curves), surfacing as the param snapshot plus param-update events. Yet notes and
param-updates ride the SAME pulled, offset-sorted event stream, so the device's one split loop handles
both, while raw params stay a snapshot the device can read without timing.

### Route E: routing and sidechain (device declares, host resolves and orders)

TS: a Gate, Compressor, or Vocoder resolves its sidechain pointer to a box address, looks that address up
in the global `AudioOutputBufferRegistry`, takes the source buffer, and registers an edge so the source
runs first (`GateDeviceProcessor.ts:86-100`, `AudioOutputBufferRegistry.ts:12-27`,
`CompressorDeviceProcessor.ts:144-148`, `VocoderDeviceProcessor.ts:103-108`). This is why the whole
project must be one flat graph: a sidechain edge can cross unit boundaries, and only a single global
topological sort can order arbitrary cross-unit dependencies without cycles. Aux sends are the same
shape, tapping a buffer and adding two edges (`AuxSendProcessor.ts`, `AudioDeviceChain.ts:193-199`).

Our model: the device never resolves pointers or buffers. A device may take MANY audio inputs, a main
plus one or more sidechain or aux sources (a Vocoder, for instance, has a carrier and a modulator). For
each, the host wrapper resolves the target through the existing `AudioOutputBufferRegistry`, registers
the ordering edge, and adds the resolved buffer to the descriptor's inputs (`Ports.inputs`). The device
declares in its manifest how many inputs it has and each one's role. So extra inputs reduce to more
entries in the inputs array the host fills, plus a host-side edge each. No new device-facing concept
beyond more inputs.

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

The descriptor stays a flat `u32[]` of byte offsets into shared memory, and `process` is called once per
quantum with the full `ProcessInfo`. The engine NEVER splits and NEVER pushes an event array. Events are
PULLED by the device through a host import into a device-owned scratch buffer, and the device times its
own sub-blocks (Route A). So the descriptor carries the block array, the buffers, the param snapshot, and
an input-event scratch the pull writes into, not a pre-filled event list.

Descriptor (extends the current `abi` layout):

```
[0]  frames                          // render quantum length (buffer length), e.g. 128
[1]  in_count    [2] in_offsets_ptr  // N audio inputs: main plus any sidechain/aux sources, roles by manifest
[3]  out_count   [4] out_offsets_ptr // N audio outputs
[5]  param_count [6] params_ptr      // current-value snapshot at quantum start (Route D); refined by pulled param-updates
[7]  state_ptr                       // stable per device instance, talc-allocated by the host
[8]  in_event_cap  [9] in_events_ptr     // device-owned scratch the pull writes into (NOT pre-filled)
[10] out_event_cap [11] out_events_ptr   // a MIDI fx / generative device's pull-response buffer (event-output devices only)
[12] block_count   [13] blocks_ptr       // the ProcessInfo -> Block[]
```

`Block` (the `ProcessInfo` element, mirroring `engine-env::Block`):

```
index:u32  p0:f64  p1:f64  s0:u32  s1:u32  bpm:f32  flags:u32
```

The device receives all blocks for the quantum and may process the whole `[0, frames)` ignoring them, or,
for sample accuracy, walk each block's range and pull its events (`host_pull_events`), fragmenting at the
offsets. The device-SDK template/macro packages this loop so authors write only `process_audio(chunk)` +
`handle_event(event)` (audio devices) or `process_events` (MIDI fx). `sample_rate` is set once at `init`
and is not repeated per quantum.

Two entry shapes, and they fix the device's OUTPUT kind. An audio device exports `process(desc)`, called
once per quantum, writing its audio output buffer(s) in place. A MIDI effect exports
`process_events(from, to, out_ptr, max) -> count`, a PULL RESPONDER the host invokes when something
downstream pulls this device for `[from, to)`; it returns the produced events for that range (having
pulled its own upstream over a range it chose). So a MIDI fx is not driven per quantum, it is pulled, and
its range need not match the quantum (Route A, Zeitgeist).

A device outputs exactly ONE kind: audio OR events, never both. The kind IS the drive mechanism: an audio
output makes it a per-quantum-scheduled audio-graph node; an event output makes it a lazily-pulled source.
Emitting both would require being both scheduled and pulled at once, which breaks the pull mechanism. A
device may have MANY audio outputs (a multi-output sampler, Playfield's per-slot buffers), but that is
still one kind. INPUTS, by contrast, may combine audio and events (a future audio device that also
consumes note events), since consuming does not drive scheduling.

Host import table (the device's view of the engine; a small set of functions the host provides at
instantiation, callable during `process`). All pointers are byte offsets into shared memory.

```
// Events (Routes A + D): the device's OWN input event stream resolved on demand, merged + offset-sorted
// for [from,to): note lifecycle from its source (sequencer + upstream MIDI fx) plus its param-updates.
// The device times its own sub-blocks on these. Returns the count written to out_ptr (EventRecord[]).
host_pull_events(from_lo:u32, from_hi:u32, to_lo:u32, to_hi:u32, out_ptr:u32, max:u32) -> u32
// Timeline query (Route C), scoped to the calling device's audio unit (for Tape-like / generative devices
// that read whole tracks, distinct from host_pull_events which gives this device's own input stream).
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
region logic, loop math, AND block splitting / time advance. Those stay host-side or device-side
respectively. The host resolves and supplies on pull; the device times its own sub-blocks. The engine
never fragments a block for the device.

## 4. Host-side EngineContext and the per-category bridges

`engine-env::EngineContext` already has `register_processor`, `register_edge`,
`subscribe_process_phase`, the `AudioOutputBufferRegistry`, and `process`. Capabilities to add:

- an event-pull facade answering `host_pull_events` for a wrapped device: resolve the device's input
  stream (its note source = sequencer + upstream MIDI fx, plus its param-updates), merged and
  offset-sorted, for a range. Wraps the existing `NoteSequencer` / `EventBuffer`.
- a timeline-query facade for `host_query_*` (note events and audio regions for the device's audio unit
  and range), wrapping the existing sequencing and region reading.
- a sidechain resolver: given a device's sidechain target box address, return the registry entry
  (buffer plus producing node) so the wrapper can add the sidechain input(s) and register the edges.

The bridges are host-side `Processor` wrappers, each wrapping one device instance. The AUDIO bridges
(`PluginInstrument`, `PluginAudioEffect`, `CompositeDevice`) are audio-graph nodes: they set up the
descriptor (blocks, buffers, the param snapshot, the event scratch) and call the device's `process` once
per quantum. `PluginMidiEffect` is NOT an audio-graph node, it is a pull-chain link invoked only when
something downstream pulls it (calling the device's `process_events`). None of them split or push events,
they answer the device's pulls.

- `PluginInstrument` (exists, migrating): sets the blocks array and param snapshot, answers the device's
  `host_pull_events` from the note source, calls `process`, fans device output into its `AudioBuffer`.
  Today it pre-pushes events; it moves to answering pulls.
- `PluginAudioEffect` (new): sets its input(s) from the upstream buffer(s) and the param snapshot, answers
  pulls (param-updates, and notes if it consumes them), calls `process`, exposes its output buffer(s). If
  the manifest declares sidechain/aux inputs, resolves those buffers and their edges too.
- `PluginMidiEffect` (new): a `NoteEventSource` in the host chain. When pulled for `[from, to)`, it invokes
  its device's `process_events(from, to)`; the device pulls its upstream (via `host_pull_events`, over a
  range it chooses) and returns the events for `[from, to)`, which the bridge yields downstream. Lazy and
  range-flexible, so a Zeitgeist-style warp is just the device asking upstream for a different range.
- `CompositeDevice` (new, for Playfield and containers): see section 5.

Because the host wrappers are the graph nodes, the single flat graph and its topological sort are
unchanged. Sidechain, aux sends, and Playfield's internal edges are all just edges between host nodes.

Note which wrappers are AUDIO-graph nodes. The audio (topological) graph orders only audio processors by
their buffer dependencies and sidechain edges. A `PluginMidiEffect` produces no audio, so it is NOT an
audio-graph node. The MIDI chain is a separate PULL CHAIN, a per-unit linked list (sequencer -> fx -> fx
-> instrument) the host uses only to route each device's `host_pull_events` to its upstream link. The pull
runs inside the consumer's processing (the instrument, the audio-graph node), and a MIDI fx reads its own
automation at pull time, so it needs no scheduled node and no ordering edge of its own. (Minor deviation
from TS, which also registers MIDI fx as ordering edges; the pull model does not need that.)

No `yield`: Rust has no stable generators (coroutines and `gen` blocks are nightly-only), so the TS
`processNotes` generator becomes a sink callback or an `Iterator` host-side (already how `engine-env`'s
note pull works), and across the wasm ABI it is batch-into-buffer: `process_events` fills the out-events
buffer for the range and returns the count.

## 5. Composite and container devices (Playfield, and Bitwig-style containers)

TS Playfield: `incoming` is a `PlayfieldSequencer`, `outgoing` is a `MixProcessor`, and between them sit N
`SampleProcessor`s, each with its OWN `InsertReturnAudioChain`, all registered into the same engine graph
via `context.registerEdge` (`PlayfieldDeviceProcessor.ts:27-76`, `SampleProcessor.ts:27-63`). The nested
effects are ordinary, runtime-editable audio-effect devices: the user adds, removes, and reorders them
while the project runs. They cannot be baked into a Playfield binary, and the set is not known ahead of
time.

What goes into the graph is host-side `Processor` NODES, never devices. A device is a DSP black box a node
drives over the ABI, so a composite is host-expanded into several nodes, all ordinary peers in the one
flat graph, rewired on box-graph edits. For Playfield the nodes are:

- one sample-player node, which drives the Playfield device. The device plays all slots and writes ONE
  audio output buffer per busy slot (the "many outputs" case), so this single node exposes N outputs.
- per slot, a fx chain of `PluginAudioEffect` nodes whose input is that slot's player output.
- one mix node (an `AudioBusProcessor`) summing the slot fx-chain outputs, then on to the unit's channel
  strip and output bus.

The sequencer routing notes to slots lives in the player (or a small node ahead of it). Every inner effect
is the same `PluginAudioEffect` wrapper used at the top level, every connection is a `register_edge`, and
rewiring uses the existing `ProcessPhase::Before` hook. The topological sort orders player -> per-slot fx
chains -> mix because the edges say so (the mix lands after the fx, the fx after the player). One device
instance with one state block serves all slots, rather than a node per pad.

It must be the one flat graph, not a contained subgraph, for the same reason as Route E: a Playfield pad's
audio effect can have a sidechain on another audio unit's output, so that foreign producer must be ordered
BEFORE this inner effect. Only the single global topological sort can order a node living inside Playfield
against a node in a different unit. A contained subgraph could not express that cross-cutting edge. So
Playfield's inner nodes are not walled off, they are peers of every other node, and the global sort orders
the whole thing at once.

Consequences:

- The device ABI does not change and gains no composite concept. "Composite" describes only how the host
  builds and maintains a cluster of nodes from the box, never a boundary in the graph.
- The only Playfield-specific DSP unit is the multi-output sample-player device (sample playback, pitch,
  envelope, per-slot voices, one output buffer per slot). The per-slot fx, ordering, and mix are host
  graph wiring, reused wholesale from the audio-unit chain.
- A composite therefore depends on the effect-plugin path (Routes B and E) being in place first. It is the
  last thing built, not the first.
- The manifest marks a device as composite so the host knows to create the inner nodes rather than a
  single node, and where to read the pads and their inner effect lists from the box.

### Container devices (the general case, beyond Playfield)

Playfield is the simplest composite (built-in voices, per-slot fx). The general case, like Bitwig's
container devices (Instrument Layer, Instrument Selector, Drum Machine, FX Layer, FX Selector), hosts N
inner DEVICE CHAINS, where each inner chain is a FULL chain in its own right: note fx, an instrument
(which may itself be a container), and audio fx. The container routes its input to the inner chains, mixes
their outputs, and passes the result to its own following devices. Containers nest recursively.

Input routing differs per container, all host-side over the existing pull model:

- Instrument Layer / FX Layer: the input (notes or audio) is fanned to ALL inner chains in parallel.
- Instrument Selector / FX Selector: only one inner chain receives new input at a time, but a
  switched-away chain keeps rendering until its tail is silent.
- Drum Machine: each inner chain is a pad bound to a note, so a note routes to its pad; pads add choke
  groups and per-pad sends.

Each inner chain has its own mixer controls (volume, pan, mute, solo, and sends for Drum Machine), summed
by the container's mixer, then into the container's following devices.

REQUIREMENT this puts on the engine: the audio-unit chain builder must be RECURSIVE and REUSABLE. "Build a
chain" (a note or audio source -> midi-fx pull chain -> an instrument-or-container -> audio-fx nodes -> a
strip and mix) is ONE routine used at the top level AND for every inner chain, and it calls itself when an
instrument slot is filled by a container. Consequences:

- Still no ABI change. A container is a host assembly of ordinary nodes, like Playfield only deeper: a
  note fan / selector / pad-router node, N inner chains (each built by the recursive builder), per-chain
  strip nodes, a mix node, then the container's own following nodes. All flat peers in the one graph.
- An instrument slot is polymorphic: a single instrument device OR a container that expands into nested
  chains. The builder dispatches on the box.
- Routing reuses the `NoteEventSource` (and the audio buffer) model: each inner chain pulls from the
  fanned or selected source; a Selector marks chains active or inactive while letting tails ring; a Drum
  Machine maps note to pad chain.
- The flat graph still wins. An inner chain's effect can sidechain across units, ordered by the one global
  sort. Nesting never creates a contained graph, however deep.
- Built AFTER the single-instrument, audio-effect, and Playfield paths. It is their recursive
  generalization, and the foundation for arbitrary future container devices.

## 6. Requirements checklist (what the engine must provide)

Per route, the complete set a device can rely on:

- Transport and time: `frames`, `p0`, `p1`, `bpm`, `flags` (transporting, playing, discontinuous,
  bpm-changed), and ppqn. Delivered as the per-block fields of the `ProcessInfo` blocks array.
  `sample_rate` is set once at `init`.
- Event pull: a host import (`host_pull_events`) that, for a range, returns the device's resolved input
  stream (notes from its source plus param-updates) as a merged, offset-sorted `EventRecord[]`. The device
  pulls per block and times its own sub-blocks. The engine resolves but never splits and never pushes.
- Block-splitting templates: two device-SDK templates/macros packaging pull + fragment-at-offsets +
  dispatch. The `AudioProcessor` analog for audio devices (hooks `process_audio` + `handle_event`); the
  `EventProcessor` analog for MIDI fx (hook `process_events`, which emits an output event stream, no audio).
- Notes out (a MIDI fx is a pull source): the host invokes the device's `process_events(from, to)` when
  something downstream pulls it; the device pulls its own upstream over a range it chooses and returns the
  events for `[from, to)`. No per-quantum push. Range-flexible, so time warps (Zeitgeist) are just a
  different upstream range plus a position remap.
- Audio in: one or more input buffers by offset (main plus any sidechain/aux sources); count and roles by
  manifest.
- Audio out: one or more output buffers by offset (e.g. a multi-output sampler). Output is ONE kind only:
  a device emits audio OR events, never both (inputs may combine the two).
- Params: a current-value snapshot at quantum start (host-filled), with sample-accurate param-updates
  arriving through the pulled event stream (Route D). The device declares its parameter list and order in
  its manifest.
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
- Recursive chain building: one reusable builder for a device chain (note/audio source -> midi-fx ->
  instrument-or-container -> audio-fx -> strip and mix) used at the top level and inside every container,
  calling itself for nested containers, with note fan / selector / pad routing and per-chain mixing. The
  foundation for Bitwig-style container devices (section 5).

Device manifest (declared once per device, drives the host wrapper): kind (midi effect, instrument,
audio effect, composite, container), parameter list and order, the audio inputs and their roles (main,
sidechain, aux), the audio outputs, whether it emits events, whether it reads the timeline (and which
track kinds), and for containers the routing mode (layer, selector, drum) plus where the inner chains
live in the box, channel counts, state size.

## 7. Phasing

1. Move events to PULL and give devices their own timing. Add the descriptor's blocks-array, the
   event-pull import (`host_pull_events`), the in/out event scratch words, and the device-SDK
   block-splitting template/macro. Migrate `PluginInstrument` from pushing `EventRecord[]` to answering
   pulls. Generalize the bridge into `PluginAudioEffect` and `PluginMidiEffect`. Audio-effect and
   MIDI-effect plugins become possible.
2. Deliver automation (Route D): the host evaluates the value-event curves it already owns, fills the
   param snapshot at quantum start, and merges resolved param-updates into the pulled event stream. The
   split template from step 1 applies them. No pushing, no host splitting.
3. Add the sidechain resolver and the extra audio inputs (Route E). Ship a Gate or Compressor plugin as
   proof (a Vocoder exercises two sources).
4. Add the timeline query (Route C) and ship TapeDevice. This is where "query all audio and note tracks"
   lands.
5. Playfield as a multi-output sample-player node plus per-slot effect-plugin chains into a mix node, all
   flat in the one graph, after the effect-plugin path (Routes B and E) is proven.
6. Container devices (Bitwig-style): make the chain builder recursive and reusable, then add note
   fan / selector / pad routing and per-chain mixing. The recursive generalization of steps 1, 4, and 5.

## 8. Scriptable devices (UNRESOLVED)

Some devices are scriptable: the user or a preset supplies code that runs at audio time, like Bitwig's The
Grid or a user-scripted generator (TS Spielwerk already hosts a WASM `UserProcessor`). These need a way to
execute code in the worklet's JS environment, not only as a precompiled wasm plugin.

No solution yet. This section only marks the requirement so the interface keeps room for it and does not
bake in "every device is a static wasm module". Things to work out later: where the script runs (worklet
JS via `Function`/a module, compiled to wasm on the fly, or a shipped interpreter device), how it gets the
same device contract (pull events, buffers, params) across the JS boundary without breaking the zero-copy
wasm-to-wasm path, and how to keep arbitrary user code real-time safe (no blocking, no unbounded
allocation, no trapping the engine).

Status: UNRESOLVED. We will find a way.

## 9. Open decisions for review

High-level, decide before implementing:

- Many distinct device modules in ONE shared memory. The current device build relocates read-only data to
  a fixed `--global-base` (4 MiB). Two DIFFERENT device modules would collide there. How do we place N
  distinct device plugins in the one linear memory: a per-module base the host assigns at load, a reserved
  window per module, position-independent code, or another scheme? This blocks shipping more than one
  device type.
- Fan-out pulls in containers. When one note source feeds several consumers (Instrument Layer fans the
  same input to N inner chains), is the source pulled ONCE and the result shared, or pulled per consumer?
  A stateful upstream (a MIDI fx) cannot be pulled repeatedly for the same range without advancing its
  state wrongly, so fan-out likely needs the host to memoize a source's output per range. Decide the
  caching / sharing model.
- Device manifest delivery. How does the host learn a device's shape (kind, params and order, inputs and
  outputs and their roles, routing mode)? A manifest exported by the wasm module, derived from the box
  schema, or both?
- Parameter mapping. How does a box `AutomatableParameterField` bind to a device's `params[]` slot and
  order: by manifest index, by name, by box key?
- Event buffer sizing and overflow. Capacities for the pulled input scratch and the produced out-events
  buffer, and the policy when a device exceeds them (drop, grow, or split the pull into smaller ranges).
- Split template form: a Rust macro versus a trait-default method for the device-SDK
  `AudioProcessor` / `EventProcessor` analog.

Lower-level, to finalize when the relevant feature is scheduled:

- Active-notes query for arpeggiators: a dedicated query versus passing the active set in the descriptor.
- Param-update event carrier: a distinct `EventRecord` kind in the shared event stream versus a separate
  automation port.
- ppqn across the ABI: f64 passed as two u32 words versus a small in-memory query struct.
- `AudioRegionRecord` exact layout and the time-stretch / transient fields, against the box schema when
  Tape is scheduled.

Decided already: the device is called once per quantum with the full `ProcessInfo` (audio devices) or
pulled on demand (MIDI fx); the engine never splits or pushes events; the device times its own sub-blocks
via an (opt-in) device-SDK template; a device outputs exactly one kind (audio or events).

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
