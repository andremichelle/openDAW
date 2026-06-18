# Device processing pattern (AudioProcessor / NoteProcessor)

How a device's DSP is written and how it is driven per block. The goal is that a device author writes
only the DSP (what happens to one contiguous run of samples, and what happens on one event) and never
re-implements the block / event bookkeeping. This mirrors the TS base classes `AbstractProcessor` and
`AudioProcessor`.

## What a plugin compiles against

The shared vocabulary lives in one foundational crate, the engine's own standard library, working name
**`engine-env`**. It holds the types and traits both the engine and every device speak: the render
`Block`, `AudioBuffer`, the note-lifecycle `Event`, the device traits, and the processing templates
below. `transport` depends on `engine-env` for `Block` (not the other way round), so the timeline and
the devices share one block definition.

A device crate is then a thin `cdylib` (see `device-plugins.md`) depending only on:

- **`engine-env`** for the contract (traits, templates, shared types). Nothing from the engine graph.
- the common **`dsp`** lib for primitives (oscillators, envelopes, filters, `fast_sin`, `midi_to_hz`).

Release builds already set `lto = true` + `opt-level = "z"`, so the linker tree-shakes: a device that
uses one envelope from `dsp` does not carry the rest into its `.wasm`. The host framework (`processors`:
graph, sequencer, units) also builds on `engine-env`, but devices never depend on it.

## The shared problem (why a template)

Every audio device faces the same per-block chore, taken from TS `AudioProcessor.process`:

1. Receive one render `Block` (`p0..p1` pulses, `s0..s1` samples, `bpm`, flags) plus the events that
   fall inside it, already sorted by sample offset.
2. Walk the events. Render audio for the run of samples up to the next event offset, then apply the
   event at that boundary, then continue. The block is split into sub-blocks at event offsets.
3. One-shot flags (discontinuous, bpm-changed) apply only to the first sub-block, then clear.

Instruments and audio effects both do this. Only the two inner steps differ per device: what one event
does, and what one run of samples does. So those two become the hooks, and the walk is shared.

## Mechanism: template method via default trait methods (no macro)

The shared walk is a **default method** on a trait. The device implements only the hooks. This is the
direct Rust form of the TS abstract base. A macro is not needed and would be worse here, because we are
sharing behavior, not generating fields or impls, and a default method stays ordinary, debuggable code.

Sketch (names provisional, to refine when we implement):

```
// in engine-env
pub trait AudioProcessor {
    fn handle_event(&mut self, event: &Event);                       // note on/off, or a param change
    fn process_audio(&mut self, chunk: &Block, output: &mut AudioBuffer);

    // provided: the shared block/event split, identical for every device
    fn process(&mut self, block: &Block, events: &[Timed<Event>], output: &mut AudioBuffer) {
        // render up to each event offset -> process_audio(sub-block); apply event -> handle_event; repeat
    }
}
```

`Event` is one enum, like the TS `Event` union: note-on, note-complete (off), and parameter-change.
The template dispatches on it (param changes update automation, notes reach `handle_event`), so there
is no per-device generic. `Timed<Event> { offset: usize, event: Event }` is the already-offset event
the host hands over (our current `TimedNote` is the note case). Unlike TS we pass sample offsets
directly, since the sequencer already resolved pulses to samples, so the template does not redo that.

The note side is a separate, **pull-based** template mirroring TS `NoteEventSource` exactly: a
`process_notes(from, to, flags)` that yields note-lifecycle events for the range. This is the interface
the note sequencer (region looping + retainer) and every MIDI effect implement, and a MIDI effect
chains by pulling from its upstream source. We need this pull shape specifically for the **Zeitgeist**
device (a generative note source), so it is not optional. Rust has no `yield`, so the yield becomes a
sink callback (`&mut dyn FnMut(Timed<Event>)`), alloc-free and still pull-ordered.

## The device traits

Over a shared `Device` lifecycle (`reset`), the three kinds the chain needs:

| trait        | in     | out    | driven by         | example            |
|--------------|--------|--------|-------------------|--------------------|
| `Instrument` | notes  | audio  | `AudioProcessor`  | sine synth         |
| `AudioEffect`| audio  | audio  | `AudioProcessor`  | filter, delay      |
| `MidiEffect` | notes  | notes  | `NoteEventSource` | arpeggio, Zeitgeist|

`Instrument` and `AudioEffect` both render through the `AudioProcessor` template (their `handle_event`
differs: a note-on/off versus a parameter change). `MidiEffect` runs through the pull-based
`NoteEventSource` template.

## One flat graph (composite devices + sidechain)

There is exactly **one** audio graph for the whole project. Every processor is a node in it: each audio
unit's instrument + effects + channel strip, every bus, the output, and every composite device's
internal processors. There are no nested or per-device sub-graphs.

A device is not always one node. `PlayfieldDeviceProcessor` is a cluster: a sequencer (its `incoming`
port) feeds N `SampleProcessor`s, one per pad, summed by a `MixProcessor` (its `outgoing` port), and
each pad carries its own audio-effects chain (`InsertReturnAudioChain` over `adapter.audioEffects`). TS
registers all of these into the single engine graph via `context.registerProcessor` / `registerEdge`;
the device merely exposes `incoming` / `outgoing` ports so the outer audio-unit chain connects to it as
if it were one node. Our model does the same: a device/unit contributes its node(s) + internal edges to
the one graph and exposes port node-ids. The same `AudioEffect` trait and chain wiring are reused at
the unit level and inside a composite device, all flat. A simple device (the sine synth) is one node.

**Why it must be one graph: sidechaining.** A Gate, Compressor, or Vocoder taps a sidechain source that
can be *any* other processor's output anywhere in the project, and that source must be computed before
the consumer. TS does this by registering an ordinary edge in the single graph,
`registerEdge(output.processor, this.incoming)` (`GateDeviceProcessor.ts:97`), so the one global
topological sort orders the source first. A nested/recursive graph cannot express or order an edge that
crosses cluster boundaries, so it would break sidechaining (and any cross-routing). Hence: one graph,
one global topsort, arbitrary edges.

**Resolving routing targets.** A sidechain (or bus) pointer targets a *box address*, not a node. An
output-buffer registry maps each box address to its output node + output buffer (TS
`audioOutputBufferRegistry`; e.g. `SampleProcessor` does `register(address, buffer, outgoing)`). The
engine resolves a sidechain pointer through the registry to get the buffer to read and the node to
depend on, then adds the edge.

**What we port (not invent).** TS routes audio with buffer references, not through the graph. Each
processor owns its `audioOutput` buffer; a consumer holds a reference to its source's output via
`setAudioSource`, and a bus sums an `Array<AudioBuffer>` collected via `addAudioSource`
(`AudioBusProcessor.process`). The `lib-dsp` `Graph` + `TopologicalSort` carry **only ordering**
(predecessors), so a registered edge just means "source runs before target". A Gate reads its main
source buffer and, separately, the sidechain buffer it resolved through the registry. So we port these
TS pieces verbatim in structure rather than designing a buffer-arena graph:

- `Graph` + `TopologicalSort` (`lib/dsp/src/graph.ts`) — ordering only, recomputed on wiring change.
- `Processor` (`process(ProcessInfo)`, `reset`, `eventInput`), `AudioGenerator` (`audioOutput`),
  `AudioInput` (`setAudioSource`), and a bus's `addAudioSource` summing list.
- `AudioOutputBufferRegistry` — box address to {buffer, processor}, for sidechain / bus resolution.
- `ProcessPhase` (Before/After) — wiring is (re)built in the Before phase, never mid-render.

### The EngineContext (the device's handle to the engine)

Every processor/device is constructed with an `EngineContext` and uses it to register itself and its
routing. This is the handle a device gets. The TS surface to port (`EngineContext.ts`):

- `registerProcessor(processor)` / `registerEdge(source, target)` — add a node / an ordering edge.
- `subscribeProcessPhase(observer)` — run (re)wiring in `ProcessPhase.Before`.
- `audioOutputBufferRegistry` — register / look up output buffers by address.
- `getAudioUnit(uuid)`, `updateClock`, `timeInfo`, `mixer`, `broadcaster`, `baseFrequency`, ...

A composite device (Playfield) uses the same handle to register its sequencer, pads, each pad's
`AudioEffect` chain, and its mix into the one graph, and exposes `incoming` / `outgoing` ports. Nothing
owns a private graph; the `EngineContext` + the ordering graph + buffer references are the only
infrastructure, ported from TS.

## Static vs dynamic composition (one DSP, two wrappers)

`device-plugins.md` requires that device code be identical whether statically composed or loaded at
runtime. The template makes that true: the `handle_event` / `process_audio` (or note) hooks are the
device, unchanged. Only the outer wrapper differs.

- **Static (now):** the host holds a `Box<dyn Instrument>` and calls `process(block, events, out)`
  directly. This is enough for the first musical sound (port-order Phase 2, step 8).
- **Dynamic (Phase 4, Device ABI v1):** an `extern "C" fn process(desc_ptr)` shim (the `abi` crate)
  decodes the shared-memory descriptor into safe slices and calls the very same hooks. The descriptor
  today carries audio ports + params + state but no event input, so instruments over the binary ABI
  wait on adding a (CLAP-shaped) event port. That is exactly the Phase-4 ABI work, not pulled forward.

So: build the templates and the static path now, behind the interface crate, so the device DSP is
already in its final shape when the binary ABI lands.

## Decided

- **One** shared crate **`engine-env`** folds everything reused by both engine and devices: `Block`,
  `AudioBuffer`, the `Event` model, PPQN, the processor interfaces + bases + `Graph`, the
  `EngineContext` trait, the registry, and the note-lifecycle / retainer types. The current `value` and
  `processors` crates and PPQN move in here, one crate for now. `transport` and devices depend on it.
- The per-block event is one shared `Event` enum (TS-style), not a per-device generic.
- The note side is pull-based, mirroring TS `NoteEventSource.processNotes` (sink callback in Rust).
  Required for Zeitgeist.
- Drop the public `incoming` / `outgoing` accessor pair; devices declare boundary ports once via the
  `EngineContext` handle and wiring connects by address (see `processor-port-map.md`).

## Open questions

- The note-event sink signature (`&mut dyn FnMut(Timed<Event>)`) versus a small returned buffer, and
  exactly how a MIDI effect holds its upstream source for pull-chaining.
- Composite devices across the plugin ABI: a composite instrument hosting sub-device fx as a recursive
  host (each sub-effect its own plugin) vs. an in-crate nested chain. In-crate is fine for Phase-A
  first-party devices; recursive hosting is a Phase-B question.
