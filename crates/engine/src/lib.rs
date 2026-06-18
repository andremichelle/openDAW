//! The WASM audio-engine module: a downstream `BoxGraph` mirror fed the live FORWARD-only sync
//! stream (`SyncSource` -> worklet/test bridge). JS copies the serialized `UpdateTask[]` into the
//! input buffer, calls `apply_updates(len)`, then reads the 32-byte checksum buffer to compare
//! against the TS source after every transaction.
//!
//! All engine state lives in one `Engine` struct held in a single `Shared` cell (an `UnsafeCell`
//! asserted `Sync` for this single-threaded module), plus the four fixed I/O buffers JS reaches by
//! pointer. The `extern "C"` exports are thin wrappers that call into the `Engine`; its methods are
//! ordinary safe Rust on `&mut self`. Box-graph subscriptions never touch the `Engine` — doing so
//! would alias the `&mut self` a transaction already holds — so they record scalar edits into a
//! shared `Controls` of `Cell`s that `render` applies (mirroring how the value/note collections keep
//! their own `Rc<RefCell<..>>` state off the engine).
//!
//! ALLOCATOR: talc (`WasmDynamicTalc`), a reclaiming allocator that grows linear memory via
//! `memory.grow` on demand and frees blocks back for reuse. Single-threaded build, so no lock.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell, UnsafeCell};
use bindings::note_collection::NoteCollection;
use bindings::value_collection::ValueCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::Registry;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::decode_forward;
use abi::{EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::audio_generator::AudioGenerator;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::engine_context::EngineContext;
use engine_env::event::Event;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::note_event_instrument::{NoteEventInstrument, SharedNoteEventSource};
use engine_env::note_region::NoteRegion;
use engine_env::note_region_source::NoteRegionSource;
use engine_env::note_sequencer::NoteSequencer;
use engine_env::ppqn::pulses_to_samples;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use studio_boxes::registry;
use transport::transport::{Transport, RENDER_QUANTUM};
use value::event::EventCollection;
use value::note::NoteEvent;

// The sine device plugin (`device_sine.wasm`), loaded as a separate module sharing this engine's linear
// memory. The host wires these imports to the device's exports and points the device's stack pointer at
// an engine-allocated stack (see `build-wasm.sh` + the worklet). The engine builds the descriptor in
// shared memory and calls `instrument_process` wasm-to-wasm — zero copy.
#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "instrument")]
extern "C" {
    #[link_name = "process"]
    fn instrument_process(desc_ptr: u32);
    #[link_name = "state_size"]
    fn instrument_state_size() -> u32;
}

// On native (cargo test compiles the lib), the device imports are unavailable; stub them so the crate
// builds. The audio path only runs under wasm.
#[cfg(not(target_family = "wasm"))]
unsafe fn instrument_process(_desc_ptr: u32) {}
#[cfg(not(target_family = "wasm"))]
unsafe fn instrument_state_size() -> u32 {
    0
}

// The device's relocated read-only data sits at `--global-base=4 MiB` (build-wasm.sh). Nothing here
// needs to reserve it: talc's `WasmGrowAndClaim` only ever claims pages it grows ABOVE the initial
// linear memory (16 MiB), so the heap never reaches down to 4 MiB. A bss "reserve" would be worse than
// useless: with imported memory the linker zero-fills bss on instantiation, and a reserve spanning
// 4 MiB would wipe the device's data segment (its exp2f table etc.) right after the device wrote it.
const DEVICE_STACK_SIZE: usize = 256 * 1024; // talc-allocated stack handed to the device
const DEVICE_MAX_EVENTS: usize = 256; // per-quantum note events passed to the device

mod metronome;
use metronome::Metronome;

const INPUT_CAPACITY: usize = 1 << 20; // 1 MiB scratch for one transaction's update bytes
const DEFAULT_SAMPLE_RATE: f32 = 48_000.0; // used by `reset` (data-path only; init sets the real rate)

/// A process-global cell for the single-threaded wasm module: an `UnsafeCell` asserted `Sync`, the
/// same shape talc uses for its allocator. SAFETY rests on the engine being driven by one thread,
/// with no overlapping `&mut` to the same cell.
struct Shared<T>(UnsafeCell<T>);

// SAFETY: only the audio thread runs engine code, so there is never concurrent access (the shared
// memory lets the main thread write sample data, but it never executes the engine).
unsafe impl<T> Sync for Shared<T> {}

impl<T> Shared<T> {
    const fn new(value: T) -> Self {
        Self(UnsafeCell::new(value))
    }

    /// SAFETY: callers must not hold two overlapping `&mut` to the same cell (single-threaded,
    /// non-reentrant use only).
    #[allow(clippy::mut_from_ref)]
    unsafe fn get(&self) -> &mut T {
        &mut *self.0.get()
    }
}

// The single engine instance + the four fixed I/O buffers JS reaches by pointer. The buffers are kept
// out of `Engine` so their addresses are stable and the 1 MiB input never lands on the stack during
// `Engine` construction.
static ENGINE: Shared<Option<Engine>> = Shared::new(None);
static INPUT: Shared<[u8; INPUT_CAPACITY]> = Shared::new([0; INPUT_CAPACITY]);
static CHECKSUM: Shared<[u8; 32]> = Shared::new([0; 32]);
static OUTPUT: Shared<[f32; RENDER_QUANTUM * 2]> = Shared::new([0.0; RENDER_QUANTUM * 2]);
static ENGINE_STATE: Shared<[u8; ENGINE_STATE_LEN]> = Shared::new([0; ENGINE_STATE_LEN]);

// WASM CONTRACT: EngineStateSchema byte layout (studio-adapters/EngineStateSchema.ts), big-endian.
// We expose the raw schema payload (no SyncStream Atomics header — the harness is single main-thread);
// JS decodes it with `EngineStateSchema().read(...)`. Field order = byte order.
const STATE_POSITION: usize = 0; // f32 (ppqn)
const STATE_BPM: usize = 4; // f32
const STATE_PLAYBACK_TIMESTAMP: usize = 8; // f32
const STATE_COUNT_IN_REMAINING: usize = 12; // f32
const STATE_IS_PLAYING: usize = 16; // u8 bool
const STATE_IS_COUNTING_IN: usize = 17; // u8 bool
const STATE_IS_RECORDING: usize = 18; // u8 bool
const STATE_PERF_INDEX: usize = 19; // i32
const STATE_PERF_BUFFER: usize = 23; // f32[PERF_BUFFER_SIZE]
const PERF_BUFFER_SIZE: usize = 512;
const ENGINE_STATE_LEN: usize = STATE_PERF_BUFFER + PERF_BUFFER_SIZE * 4;

/// Scalar timeline values the box-graph subscriptions record and `render` applies to the transport /
/// metronome. Holding them in `Cell`s (shared via `Rc`) keeps the subscription closures off the
/// `Engine`, so they never alias the `&mut Engine` a transaction holds.
struct Controls {
    bpm: Cell<f32>,
    nominator: Cell<i32>,
    denominator: Cell<i32>,
    loop_enabled: Cell<bool>,
    loop_from: Cell<f64>,
    loop_to: Cell<f64>,
    tempo_automation_enabled: Cell<bool>
}

impl Controls {
    fn new() -> Self {
        Self {
            bpm: Cell::new(120.0),
            nominator: Cell::new(4),
            denominator: Cell::new(4),
            loop_enabled: Cell::new(false),
            loop_from: Cell::new(0.0),
            loop_to: Cell::new(0.0),
            tempo_automation_enabled: Cell::new(true)
        }
    }
}

/// The note content one instrument's sequencer reads (the `NoteRegionSource` the engine binds from the
/// box graph): one audio unit's note regions, each region's loopable span paired with its observed
/// `NoteEventCollection`. Regions may share a `NoteEventCollectionBox` (mirrored regions); each gets its
/// own `NoteCollection` view.
struct BoundNoteRegions {
    regions: Vec<(NoteRegion, NoteCollection)>
}

impl NoteRegionSource for BoundNoteRegions {
    fn for_each_region(&self, _from: f64, _to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        for (region, collection) in &self.regions {
            visit(region, &collection.events());
        }
    }
}

/// A graph node that voices its notes through the loaded `device_sine.wasm` plugin. It pulls notes from
/// its `NoteEventInstrument`, resolves them to sample-offset `EventRecord`s for the quantum, fills the
/// engine-allocated (shared-memory) descriptor + event buffer, and calls the device's `process`
/// wasm-to-wasm (zero copy). The device renders into the engine-allocated mono output buffer, which this
/// node fans out to its stereo output for the master bus. All device-facing memory (state, IO, descriptor)
/// is talc-allocated here, so it is freed when the instrument is dropped.
struct PluginInstrument {
    sample_rate: f32,
    note_input: NoteEventInstrument,
    events: EventBuffer,
    output: SharedAudioBuffer,
    device_output: Box<[f32]>,
    device_events: Box<[EventRecord]>,
    // `device_state` / `out_offsets` are referenced only by raw address inside `descriptor`; they must
    // stay alive (dropping them frees the memory the device reads), so keep the fields even though Rust
    // sees no direct reads.
    #[allow(dead_code)]
    device_state: Box<[u32]>, // u32 so the block is 4-aligned for the device's SynthState
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    descriptor: Box<[u32]>
}

impl PluginInstrument {
    fn new(sample_rate: f32) -> Self {
        let device_output = vec![0.0f32; RENDER_QUANTUM].into_boxed_slice();
        let blank = EventRecord {offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
        let device_events = vec![blank; DEVICE_MAX_EVENTS].into_boxed_slice();
        let state_size = unsafe { instrument_state_size() } as usize;
        let device_state = vec![0u32; state_size.div_ceil(4)].into_boxed_slice(); // 4-aligned, >= state_size bytes
        let out_offsets = vec![device_output.as_ptr() as u32].into_boxed_slice();
        // descriptor words (see the `abi` layout): frames, in_count/ptr, out_count/ptr, param_count/ptr,
        // state_ptr, event_count/ptr.
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            0, 0,
            1, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            0, device_events.as_ptr() as u32
        ].into_boxed_slice();
        Self {
            sample_rate,
            note_input: NoteEventInstrument::new(),
            events: EventBuffer::new(),
            output: shared_audio_buffer(),
            device_output,
            device_events,
            device_state,
            out_offsets,
            descriptor
        }
    }

    fn set_note_event_source(&mut self, source: SharedNoteEventSource) {
        self.note_input.set_note_event_source(source);
    }
}

/// The sample offset within the quantum for a note at pulse `position`, clamped to the block.
fn sample_offset(position: f64, block: &Block, sample_rate: f32) -> usize {
    let pulses = position - block.p0;
    let raw = if pulses.abs() < 1.0e-7 {
        block.s0
    } else {
        block.s0 + pulses_to_samples(pulses, block.bpm, sample_rate) as usize
    };
    raw.clamp(block.s0, block.s1)
}

impl EventReceiver for PluginInstrument {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for PluginInstrument {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for PluginInstrument {
    fn reset(&mut self) {
        self.events.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        self.events.clear();
        let mut count = 0;
        for block in info.blocks {
            self.note_input.fill(block, &mut self.events);
            for event in self.events.get(block.index) {
                if count >= DEVICE_MAX_EVENTS {
                    break;
                }
                let record = match *event {
                    Event::NoteStart {id, position, pitch, cent, velocity, ..} => EventRecord {
                        offset: sample_offset(position, block, self.sample_rate) as u32,
                        kind: EVENT_NOTE_ON,
                        id: id as u32,
                        pitch: pitch as u32,
                        velocity,
                        cent
                    },
                    Event::NoteComplete {id, position, pitch} => EventRecord {
                        offset: sample_offset(position, block, self.sample_rate) as u32,
                        kind: EVENT_NOTE_OFF,
                        id: id as u32,
                        pitch: pitch as u32,
                        velocity: 0.0,
                        cent: 0.0
                    },
                    Event::Update {..} => continue
                };
                self.device_events[count] = record;
                count += 1;
            }
        }
        self.device_events[..count].sort_by_key(|record| record.offset);
        self.descriptor[0] = RENDER_QUANTUM as u32;
        self.descriptor[8] = count as u32;
        unsafe { instrument_process(self.descriptor.as_ptr() as u32) }
        let mut output = self.output.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            let sample = self.device_output[index];
            output.left[index] = sample;
            output.right[index] = sample;
        }
    }
}

struct Engine {
    graph: BoxGraph,
    registry: Registry,
    transport: Transport,
    metronome: Metronome,
    tempo: Option<ValueCollection>,
    context: EngineContext,
    output_bus: Option<SharedAudioBuffer>,
    sample_rate: f32,
    blocks: Vec<Block>,
    device_stack: Option<Box<[u8]>>, // talc-allocated stack handed to the device plugin
    controls: Rc<Controls>
}

impl Engine {
    fn new(sample_rate: f32) -> Self {
        Self {
            graph: BoxGraph::from_boxes(Vec::new()),
            registry: registry(),
            transport: Transport::new(sample_rate, 120.0),
            metronome: Metronome::new(sample_rate),
            tempo: None,
            context: EngineContext::new(),
            output_bus: None,
            sample_rate,
            blocks: Vec::new(),
            device_stack: None,
            controls: Rc::new(Controls::new())
        }
    }

    /// Allocate (from talc) the stack the device plugin runs on, and return its top address. The host
    /// sets the device's `__stack_pointer` to this before any `process` call, so the device's stack
    /// lives in engine-owned memory disjoint from the engine's own stack. Call once, before `bind`.
    fn setup_device(&mut self) -> u32 {
        let stack = vec![0u8; DEVICE_STACK_SIZE].into_boxed_slice();
        let top = stack.as_ptr() as u32 + DEVICE_STACK_SIZE as u32; // wasm stack grows down from the top
        self.device_stack = Some(stack);
        top
    }

    /// Apply one forward-only transaction, returning the resulting checksum (or `Err` on a
    /// decode/apply failure). The value/note caches update themselves inside `transaction`.
    fn apply_updates(&mut self, input: &[u8]) -> Result<[u8; 32], ()> {
        let mut reader = ByteReader::new(input);
        let updates = decode_forward(&mut reader).map_err(|_| ())?;
        self.graph.transaction(&updates, &self.registry).map_err(|_| ())?;
        Ok(self.graph.checksum())
    }

    /// Render one quantum into `output` (planar L|R) and write the transport state into `state`.
    fn render(&mut self, output: &mut [f32], state: &mut [u8]) {
        for sample in output.iter_mut() {
            *sample = 0.0
        }
        // disjoint field borrows so the render closure can hold the metronome / block scratch while
        // `render_quantum` holds the transport.
        let Engine {transport, metronome, context, output_bus, blocks, tempo, controls, ..} = self;
        // apply the latest timeline values recorded by the subscriptions
        transport.set_bpm(controls.bpm.get());
        transport.set_loop_enabled(controls.loop_enabled.get());
        transport.set_loop_from(controls.loop_from.get());
        transport.set_loop_to(controls.loop_to.get());
        metronome.set_nominator(controls.nominator.get() as u32);
        metronome.set_denominator(controls.denominator.get() as u32);
        if transport.is_playing() {
            blocks.clear();
            // use the tempo map only when automation is enabled and non-empty, else the fixed bpm
            let events = if controls.tempo_automation_enabled.get() {
                tempo.as_ref().map(|tempo| tempo.events())
            } else {
                None
            };
            let active = events.as_deref().filter(|collection| !collection.is_empty());
            // collect this quantum's blocks (converting transport flags) and run the metronome per block
            transport.render_quantum(active, |block| {
                let (left, right) = output.split_at_mut(RENDER_QUANTUM);
                metronome.process(block, &mut left[block.s0..block.s1], &mut right[block.s0..block.s1]);
                blocks.push(Block {
                    index: blocks.len() as u32,
                    p0: block.p0,
                    p1: block.p1,
                    s0: block.s0,
                    s1: block.s1,
                    bpm: block.bpm,
                    flags: BlockFlags::create(true, block.discontinuous, true, false)
                });
            });
            // drive the processor graph over those blocks, then mix the output unit's buffer in
            context.process(&ProcessInfo {blocks: blocks.as_slice()});
            if let Some(buffer) = output_bus.as_ref() {
                let buffer = buffer.borrow();
                for index in 0..RENDER_QUANTUM {
                    output[index] += buffer.left[index];
                    output[RENDER_QUANTUM + index] += buffer.right[index];
                }
            }
        }
        write_engine_state(transport, state);
    }

    fn play(&mut self) {
        self.transport.play()
    }

    fn stop(&mut self) {
        self.transport.stop(false)
    }

    fn set_metronome_enabled(&mut self, enabled: bool) {
        self.metronome.set_enabled(enabled)
    }

    /// Subscribe the timeline controls + the tempo / note collections to the synced `TimelineBox`.
    /// Each control subscription captures an `Rc<Controls>` clone and records into a `Cell` only.
    /// Returns 0 on success, 1 if no `TimelineBox` is present.
    fn bind(&mut self) -> i32 {
        let uuid = match self.graph.find_by_name("TimelineBox") {
            Some(timeline) => timeline.uuid,
            None => return 1
        };
        let bpm = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![31]), move |value| {
            if let Some(value) = value.as_float32() {
                bpm.bpm.set(value)
            }
        });
        // tempo automation on/off: TimelineBox.tempoTrack (22).enabled (20).
        let tempo_enabled = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![22, 20]), move |value| {
            if let Some(value) = value.as_bool() {
                tempo_enabled.tempo_automation_enabled.set(value)
            }
        });
        // signature: TimelineBox.signature (10) = {nominator (1), denominator (2)}.
        let nominator = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![10, 1]), move |value| {
            if let Some(value) = value.as_int32() {
                nominator.nominator.set(value)
            }
        });
        let denominator = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![10, 2]), move |value| {
            if let Some(value) = value.as_int32() {
                denominator.denominator.set(value)
            }
        });
        // loop area: TimelineBox.loopArea (11) = {enabled (1, bool), from (2, i32), to (3, i32) pulses}.
        let loop_enabled = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![11, 1]), move |value| {
            if let Some(value) = value.as_bool() {
                loop_enabled.loop_enabled.set(value)
            }
        });
        let loop_from = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![11, 2]), move |value| {
            if let Some(value) = value.as_int32() {
                loop_from.loop_from.set(value as f64)
            }
        });
        let loop_to = self.controls.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![11, 3]), move |value| {
            if let Some(value) = value.as_int32() {
                loop_to.loop_to.set(value as f64)
            }
        });
        // tempo-automation collection: TimelineBox.tempoTrack (22).events (1) -> ValueEventCollectionBox.owners
        let tempo_collection = self.graph.target_of(&Address::of(uuid, vec![22, 1])).map(|target| target.uuid);
        if let Some(collection) = tempo_collection {
            self.tempo = Some(ValueCollection::observe(&mut self.graph, collection));
        }
        self.build_audio_graph();
        0
    }

    /// Build the processor graph from the box graph: a master output bus whose buffer feeds the worklet,
    /// plus one `PluginInstrument` (the sine device) PER AUDIO UNIT, each fed by a `NoteSequencer` over
    /// that unit's note regions and routed into the master bus. The device wasm is loaded once; every
    /// instrument calls it with its own state block, so the units play independently.
    /// DEVIATION from the TS engine: every unit uses the sine device — the unit's actual `input`
    /// instrument device and its audio-effect chain are not read yet.
    fn build_audio_graph(&mut self) {
        let output_buffer = shared_audio_buffer();
        let master = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer.clone())));
        let master_id = self.context.register_processor(master.clone());
        self.output_bus = Some(output_buffer);
        for regions in self.bind_note_regions_by_unit() {
            let source: SharedNoteEventSource = Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {regions}))));
            let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate)));
            instrument.borrow_mut().set_note_event_source(source);
            master.borrow_mut().add_audio_source(instrument.borrow().audio_output());
            let instrument_id = self.context.register_processor(instrument);
            self.context.register_edge(instrument_id, master_id); // instrument renders before the bus sums it
        }
    }

    /// Group every `NoteRegionBox` by its owning audio unit, returning one bound-region list per unit (in
    /// discovery order). The chain is pointer-only: region.regions (key 1) -> the track's regions hub,
    /// track.tracks (key 1) -> the unit's tracks hub. Regions that resolve to no unit are grouped together
    /// (one fallback instrument) so they still sound.
    fn bind_note_regions_by_unit(&mut self) -> Vec<Vec<(NoteRegion, NoteCollection)>> {
        let mut bound_per_unit = Vec::new();
        for members in group_regions_by_unit(&self.graph) {
            let bound: Vec<(NoteRegion, NoteCollection)> =
                members.into_iter().filter_map(|region_uuid| self.bind_region(region_uuid)).collect();
            if !bound.is_empty() {
                bound_per_unit.push(bound);
            }
        }
        bound_per_unit
    }

    /// Read one region's loopable span (position 10, duration 11, loopOffset 12, loopDuration 13) and
    /// observe the `NoteEventCollectionBox` its `events` pointer (key 2) targets. `None` if it has none.
    fn bind_region(&mut self, region_uuid: Uuid) -> Option<(NoteRegion, NoteCollection)> {
        let region = NoteRegion {
            position: self.read_pulses(region_uuid, 10),
            duration: self.read_pulses(region_uuid, 11),
            loop_offset: self.read_pulses(region_uuid, 12),
            loop_duration: self.read_pulses(region_uuid, 13)
        };
        let collection_uuid = self.graph.target_of(&Address::of(region_uuid, vec![2]))?.uuid;
        let collection = NoteCollection::observe(&mut self.graph, collection_uuid);
        Some((region, collection))
    }

    fn read_pulses(&self, uuid: Uuid, key: u16) -> f64 {
        self.graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
    }
}

/// Group note-region uuids by their owning audio unit, in discovery order: region.regions (key 1) ->
/// the track, then track.tracks (key 1) -> the unit. Regions resolving to no unit (orphans) collect into
/// the `None`-keyed group, kept so they still sound. Pure over the box graph (unit-tested).
fn group_regions_by_unit(graph: &BoxGraph) -> Vec<Vec<Uuid>> {
    let region_uuids: Vec<Uuid> = graph.find_all_by_name("NoteRegionBox").iter().map(|region| region.uuid).collect();
    let mut groups: Vec<(Option<Uuid>, Vec<Uuid>)> = Vec::new();
    for region_uuid in region_uuids {
        let unit = unit_of_region(graph, region_uuid);
        match groups.iter_mut().find(|(group_unit, _)| *group_unit == unit) {
            Some((_, members)) => members.push(region_uuid),
            None => groups.push((unit, vec![region_uuid]))
        }
    }
    groups.into_iter().map(|(_, members)| members).collect()
}

/// The audio unit a note region belongs to: region.regions (key 1) -> track, then track.tracks (key 1)
/// -> unit. `None` if either pointer is unset (an orphan region).
fn unit_of_region(graph: &BoxGraph, region_uuid: Uuid) -> Option<Uuid> {
    let track = graph.target_of(&Address::of(region_uuid, vec![1]))?.uuid;
    let unit = graph.target_of(&Address::of(track, vec![1]))?.uuid;
    Some(unit)
}

/// Serialize the transport state into `state` (big-endian, per the EngineState contract).
fn write_engine_state(transport: &Transport, state: &mut [u8]) {
    state[STATE_POSITION..STATE_POSITION + 4].copy_from_slice(&(transport.position() as f32).to_be_bytes());
    state[STATE_BPM..STATE_BPM + 4].copy_from_slice(&transport.bpm().to_be_bytes());
    state[STATE_PLAYBACK_TIMESTAMP..STATE_PLAYBACK_TIMESTAMP + 4].copy_from_slice(&0f32.to_be_bytes());
    state[STATE_COUNT_IN_REMAINING..STATE_COUNT_IN_REMAINING + 4].copy_from_slice(&0f32.to_be_bytes());
    state[STATE_IS_PLAYING] = transport.is_playing() as u8;
    state[STATE_IS_COUNTING_IN] = 0;
    state[STATE_IS_RECORDING] = 0;
    state[STATE_PERF_INDEX..STATE_PERF_INDEX + 4].copy_from_slice(&0i32.to_be_bytes());
}

// ---- The C ABI: thin wrappers over the single `Engine` + the I/O buffers. ----

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    unsafe { INPUT.get().as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn input_capacity() -> usize {
    INPUT_CAPACITY
}

#[no_mangle]
pub extern "C" fn checksum_ptr() -> *const u8 {
    unsafe { CHECKSUM.get().as_ptr() }
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const f32 {
    unsafe { OUTPUT.get().as_ptr() }
}

#[no_mangle]
pub extern "C" fn output_len() -> usize {
    RENDER_QUANTUM * 2
}

#[no_mangle]
pub extern "C" fn engine_state_ptr() -> *const u8 {
    unsafe { ENGINE_STATE.get().as_ptr() }
}

#[no_mangle]
pub extern "C" fn engine_state_len() -> usize {
    ENGINE_STATE_LEN
}

/// Reset to a fresh engine with an empty graph (call before replaying a fresh session).
#[no_mangle]
pub extern "C" fn reset() {
    unsafe {
        *ENGINE.get() = Some(Engine::new(DEFAULT_SAMPLE_RATE));
        CHECKSUM.get().fill(0);
    }
}

/// Apply one forward-only transaction from the first `len` input bytes, refreshing the checksum
/// buffer. Returns 0 on success, 1 on a decode/apply error.
#[no_mangle]
pub extern "C" fn apply_updates(len: usize) -> i32 {
    unsafe {
        let engine = ENGINE.get().get_or_insert_with(|| Engine::new(DEFAULT_SAMPLE_RATE));
        match engine.apply_updates(&INPUT.get()[..len]) {
            Ok(checksum) => {
                CHECKSUM.get().copy_from_slice(&checksum);
                0
            }
            Err(()) => 1
        }
    }
}

/// Initialize the engine for `sample_rate`: empty graph, a playing transport, and a metronome.
#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let mut engine = Engine::new(sample_rate);
    engine.play();
    unsafe {
        *ENGINE.get() = Some(engine);
    }
}

/// Render one 128-frame quantum into the output buffer and refresh the EngineState back-channel.
#[no_mangle]
pub extern "C" fn render() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.render(OUTPUT.get(), ENGINE_STATE.get())
        }
    }
}

#[no_mangle]
pub extern "C" fn play() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.play()
        }
    }
}

#[no_mangle]
pub extern "C" fn stop() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.stop()
        }
    }
}

#[no_mangle]
pub extern "C" fn set_metronome_enabled(enabled: i32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.set_metronome_enabled(enabled != 0)
        }
    }
}

/// Bind the synced `TimelineBox`. Returns 0 on success, 1 if absent.
#[no_mangle]
pub extern "C" fn bind() -> i32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.bind(),
            None => 1
        }
    }
}

/// Allocate the device plugin's stack and return its top address. The host sets the device's
/// `__stack_pointer` to this before any render (and before `bind`, which sizes the device state).
#[no_mangle]
pub extern "C" fn setup_device() -> u32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.setup_device(),
            None => 0
        }
    }
}

// Dynamic heap: talc claims linear memory via `memory.grow` on demand (no fixed arena) and reclaims
// freed blocks. The engine runs on ONE thread (the audio thread); the linear memory is shared only so the
// main thread can WRITE sample data into it, never to run engine code, so there is still no concurrent
// access. We wrap the non-Sync `TalcCell` and assert `Sync` (exactly what talc's own `TalcSyncCell` does),
// but keep the inner cell reachable so we can read counters, which `TalcSyncCell` does not expose. Always
// present on wasm regardless of the `atomics` feature (the shared-memory build enables it).
#[cfg(target_family = "wasm")]
mod heap {
    use core::alloc::{GlobalAlloc, Layout};
    use talc::cell::TalcCell;
    use talc::wasm::{WasmBinning, WasmGrowAndClaim};

    struct EngineAlloc(TalcCell<WasmGrowAndClaim, WasmBinning>);

    // SAFETY: only the audio thread runs engine code, so there is never concurrent access (the shared
    // memory lets the main thread write sample data, but it never executes the engine).
    unsafe impl Sync for EngineAlloc {}

    unsafe impl GlobalAlloc for EngineAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {self.0.alloc(layout)}
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {self.0.dealloc(ptr, layout)}
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {self.0.alloc_zeroed(layout)}
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            self.0.realloc(ptr, layout, new_size)
        }
    }

    #[global_allocator]
    static TALC: EngineAlloc = EngineAlloc(TalcCell::new(WasmGrowAndClaim));

    /// Bytes currently allocated (live).
    #[no_mangle]
    pub extern "C" fn heap_used() -> usize {
        TALC.0.counters().allocated_bytes
    }

    /// Total bytes the heap manages (live + free) — the claimed footprint.
    #[no_mangle]
    pub extern "C" fn heap_claimed() -> usize {
        let counters = TALC.0.counters();
        counters.allocated_bytes + counters.available_bytes
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    // Trap (observable RuntimeError) rather than `loop {}` (a silent hang), so a panic surfaces.
    core::arch::wasm32::unreachable()
}

#[cfg(test)]
mod tests {
    use super::{group_regions_by_unit, unit_of_region};
    use boxgraph::address::{Address, Uuid};
    use boxgraph::boxes::GraphBox;
    use boxgraph::field::FieldValue;
    use boxgraph::graph::BoxGraph;
    use std::collections::BTreeMap;

    fn uuid(tag: u8) -> Uuid {
        [tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }

    // A box whose only field is the key-1 pointer (region.regions -> track, track.tracks -> unit) the
    // grouping follows — the only field `group_regions_by_unit` reads.
    fn linked(creation_index: i32, name: &str, id: Uuid, key1: Option<Address>) -> GraphBox {
        GraphBox {
            creation_index,
            name: name.to_string(),
            uuid: id,
            fields: BTreeMap::from([(1u16, FieldValue::Pointer(key1))])
        }
    }

    // U1, U2 = audio units. T1->U1, T2->U2, T3 = a track with no unit. Regions: R1,R2 in T1 (mirrored),
    // R3 in T2, R4 has no track, R5 in the unit-less T3. uuids ascend with logical order (find_all_by_name
    // returns uuid order), so the grouping order is deterministic.
    fn fixture() -> (BoxGraph, [Uuid; 5]) {
        let (u1, u2) = (uuid(0x10), uuid(0x20));
        let (t1, t2, t3) = (uuid(0x11), uuid(0x21), uuid(0x31));
        let (r1, r2, r3, r4, r5) = (uuid(0x1a), uuid(0x1b), uuid(0x2a), uuid(0x4a), uuid(0x5a));
        let graph = BoxGraph::from_boxes(vec![
            linked(0, "AudioUnitBox", u1, None),
            linked(1, "AudioUnitBox", u2, None),
            linked(2, "TrackBox", t1, Some(Address::of(u1, vec![20]))),
            linked(3, "TrackBox", t2, Some(Address::of(u2, vec![20]))),
            linked(4, "TrackBox", t3, None),
            linked(5, "NoteRegionBox", r1, Some(Address::of(t1, vec![3]))),
            linked(6, "NoteRegionBox", r2, Some(Address::of(t1, vec![3]))),
            linked(7, "NoteRegionBox", r3, Some(Address::of(t2, vec![3]))),
            linked(8, "NoteRegionBox", r4, None),
            linked(9, "NoteRegionBox", r5, Some(Address::of(t3, vec![3])))
        ]);
        (graph, [r1, r2, r3, r4, r5])
    }

    #[test]
    fn unit_of_region_follows_region_track_unit() {
        let (graph, [r1, _r2, r3, r4, r5]) = fixture();
        assert_eq!(unit_of_region(&graph, r1), Some(uuid(0x10))); // R1 -> T1 -> U1
        assert_eq!(unit_of_region(&graph, r3), Some(uuid(0x20))); // R3 -> T2 -> U2
        assert_eq!(unit_of_region(&graph, r4), None); // R4 has no track
        assert_eq!(unit_of_region(&graph, r5), None); // R5's track has no unit
    }

    #[test]
    fn groups_regions_by_owning_unit_mirrored_together_orphans_pooled() {
        let (graph, [r1, r2, r3, r4, r5]) = fixture();
        let groups = group_regions_by_unit(&graph);
        // three groups, in discovery order: {R1,R2} (unit U1), {R3} (unit U2), {R4,R5} (no unit, pooled)
        assert_eq!(groups, vec![vec![r1, r2], vec![r3], vec![r4, r5]]);
    }

    #[test]
    fn empty_graph_yields_no_groups() {
        assert!(group_regions_by_unit(&BoxGraph::from_boxes(Vec::new())).is_empty());
    }
}
