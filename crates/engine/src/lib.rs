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
use abi::{BlockRecord, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON, DEVICE_KIND_EFFECT, DEVICE_KIND_INSTRUMENT, DEVICE_KIND_MIDI_EFFECT};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::engine_context::EngineContext;
use engine_env::event::Event;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::note_event_instrument::SharedNoteEventSource;
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

// Devices are PIC side modules the host loads at runtime, each at a talc-assigned base, and installs
// into the ONE shared `__indirect_function_table` (the engine is built `--import-table`). The engine
// keeps a small registry of loaded devices and calls each device's `process(desc_ptr)` by its table slot
// via `call_indirect` — wasm-to-wasm, zero copy. The host loader fills the registry through the
// `device_register` export and allocates device data + stacks through `device_alloc`.
#[derive(Clone, Copy)]
struct DeviceReg {
    process_index: u32, // slot in the shared function table holding the device's `process`
    state_size: u32,    // bytes the engine must allocate (zeroed) per instance
    kind: u32           // DEVICE_KIND_INSTRUMENT / DEVICE_KIND_EFFECT (read from the device's `kind` export)
}

// Call a device's `process` through the shared function table: a wasm function pointer IS a table index,
// so transmuting the index to a fn and calling it emits `call_indirect` on the imported table.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_process(process_index: u32, desc_ptr: u32) {
    let process: extern "C" fn(u32) = unsafe { core::mem::transmute(process_index as usize) };
    process(desc_ptr);
}
// Native (cargo test) never runs the audio path; stub so the crate builds.
#[cfg(not(target_family = "wasm"))]
fn call_device_process(_process_index: u32, _desc_ptr: u32) {}

// Call a MIDI-fx device's `process_events` pull responder through the shared function table (same
// table-index-is-fn-pointer trick as `call_device_process`). `state_ptr` is its per-instance state block.
// Returns the count of events it wrote.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_process_events(process_index: u32, from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let process_events: extern "C" fn(f64, f64, u32, u32, u32, u32) -> u32 =
        unsafe { core::mem::transmute(process_index as usize) };
    process_events(from, to, flags, state_ptr, out_ptr, max)
}
#[cfg(not(target_family = "wasm"))]
fn call_device_process_events(_process_index: u32, _from: f64, _to: f64, _flags: u32, _state_ptr: u32, _out_ptr: u32, _max: u32) -> u32 { 0 }

const DEVICE_MAX_EVENTS: usize = 256; // per-quantum event scratch the device pulls into
const DEVICE_MAX_BLOCKS: usize = RENDER_QUANTUM; // upper bound on blocks per quantum (one per sample worst case)

mod metronome;
use metronome::Metronome;

const INPUT_CAPACITY: usize = 1 << 20; // initial input scratch (1 MiB); grows on demand, keeps the high-water mark

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
// The incoming-transaction scratch the worklet writes update bytes into. A growable buffer (not a fixed
// array): pre-allocated to INPUT_CAPACITY at `init`, grown by `input_reserve` for a transaction that
// exceeds it (and kept at the high-water mark), so a huge transaction is never silently dropped and grows
// happen rarely, not per transaction.
static INPUT: Shared<Vec<u8>> = Shared::new(Vec::new());
static CHECKSUM: Shared<[u8; 32]> = Shared::new([0; 32]);
static OUTPUT: Shared<[f32; RENDER_QUANTUM * 2]> = Shared::new([0.0; RENDER_QUANTUM * 2]);
static ENGINE_STATE: Shared<[u8; ENGINE_STATE_LEN]> = Shared::new([0; ENGINE_STATE_LEN]);
// The pull context the `host_pull_events` export reads. It is set up by the audio node (PluginInstrument)
// right before it calls its device's `process`, and cleared after. Held in its OWN cell (NOT `ENGINE`), so
// the device's re-entrant `host_pull_events` call never aliases the `&mut Engine` the render path holds.
// The node scopes its `PULL.get()` borrows so none is live across the device call (single-threaded).
static PULL: Shared<PullContext> = Shared::new(PullContext::new());

/// A device's per-instance state block (talc-allocated, zeroed once, reused across calls), owned host-side
/// and addressed by the device through a raw pointer. `u32`-backed so it is 4-aligned for the device's
/// state struct. Shared via `Rc` so every clone of a `PullLink::MidiFx` addresses the SAME instance state.
struct DeviceState(Box<[u64]>);

impl DeviceState {
    // u64-backed so the block is 8-aligned for any device state struct (e.g. an arpeggiator state holding
    // f64 pulse positions); a 4-aligned block would be misaligned for those.
    fn new(bytes: usize) -> Self {
        Self(vec![0u64; bytes.div_ceil(8)].into_boxed_slice())
    }

    fn ptr(&self) -> u32 {
        self.0.as_ptr() as u32
    }
}

/// One link in a unit's event PULL CHAIN (the `NoteEventSource` chain, sequencer -> fx -> ... -> the
/// instrument that consumes it). A leaf `Source` is the note sequencer; a `MidiFx` is a MIDI-effect device
/// that, when pulled, transforms the events of its `upstream` link, holding its own per-instance `state`
/// (e.g. an arpeggiator's held-note stack). Cheap to clone (`Rc` handles), and clones share the one state.
/// This is the `PluginMidiEffect` role from the plan: a MIDI fx is NOT an audio-graph node, it is a pull link.
#[derive(Clone)]
enum PullLink {
    Source(SharedNoteEventSource),
    MidiFx { process_index: u32, state: Rc<DeviceState>, upstream: Rc<PullLink> }
}

/// What `host_pull_events` needs to resolve a device's input events for a pulse range: the CURRENT pull
/// link (shifted as the chain is descended), the quantum's blocks (to map a pulse position to a sample
/// offset), the sample rate, and a reusable scratch. The blocks pointer borrows the live `ProcessInfo`
/// for the duration of the device call.
struct PullContext {
    current: Option<PullLink>,
    blocks: *const Block,
    block_count: usize,
    sample_rate: f32,
    scratch: Vec<Event>
}

impl PullContext {
    const fn new() -> Self {
        Self {current: None, blocks: core::ptr::null(), block_count: 0, sample_rate: 0.0, scratch: Vec::new()}
    }
}

// TS `NoteLifecycleEvent.Comparator`: by position; at equal position a note-complete (off) sorts before a
// note-start (on). Mirrors `note_event_instrument::compare_lifecycle` (private there).
fn compare_lifecycle(a: &Event, b: &Event) -> core::cmp::Ordering {
    match a.position().partial_cmp(&b.position()) {
        Some(core::cmp::Ordering::Equal) | None => lifecycle_rank(a).cmp(&lifecycle_rank(b)),
        Some(order) => order
    }
}

fn lifecycle_rank(event: &Event) -> u8 {
    match event {
        Event::NoteComplete {..} => 0,
        _ => 1
    }
}

/// Host import the device calls (wasm-to-wasm via the loader binding) to PULL its own input events for the
/// pulse range `[from, to)`. It resolves the CURRENT pull link: a leaf sequencer resolves + converts to
/// sample-offset `EventRecord`s directly; a MIDI-fx link descends (routing the fx device's own upstream
/// pull to the next link) and invokes that device's `process_events`. Reads only `PULL`, never `ENGINE`,
/// so it is safe to call re-entrantly from inside `render`.
#[no_mangle]
pub extern "C" fn host_pull_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let link = {
        let pull = unsafe { PULL.get() };
        match &pull.current {
            Some(link) => link.clone(),
            None => return 0
        }
    };
    match link {
        PullLink::Source(ref source) => pull_from_source(source, from, to, flags, out_ptr, max),
        PullLink::MidiFx {process_index, state, upstream} => {
            // Descend: point the CURRENT link at the fx's upstream so the fx device's own
            // `host_pull_events` resolves it, run the fx (with its per-instance state), then restore this
            // link so the next (per-block) pull from downstream still goes through the fx. Scope each
            // `PULL.get()` so none is held across the device call (it re-enters `PULL.get()`);
            // single-threaded, so they never overlap.
            let state_ptr = state.ptr();
            { unsafe { PULL.get() }.current = Some((*upstream).clone()); }
            let count = call_device_process_events(process_index, from, to, flags, state_ptr, out_ptr, max);
            { unsafe { PULL.get() }.current = Some(PullLink::MidiFx {process_index, state, upstream}); }
            count
        }
    }
}

/// Host import a (generative) device calls to map a pulse position to its sample offset within the current
/// quantum, resolved against the block containing `pulse`. An arpeggiator uses it to time the events it
/// emits on a rate grid. Reads only `PULL`, like `host_pull_events`.
#[no_mangle]
pub extern "C" fn host_pulse_to_offset(pulse: f64) -> u32 {
    let pull = unsafe { PULL.get() };
    if pull.blocks.is_null() {
        return 0;
    }
    let blocks = unsafe { core::slice::from_raw_parts(pull.blocks, pull.block_count) };
    let block = match blocks.iter().find(|block| pulse >= block.p0 && pulse < block.p1).or_else(|| blocks.last()) {
        Some(block) => *block,
        None => return 0
    };
    sample_offset(pulse, &block, pull.sample_rate) as u32
}

/// Resolve a leaf note source for `[from, to)`: pull its events, lifecycle-sort them, and convert each to
/// a sample-offset `EventRecord` (absolute within the quantum, found via the block whose `p0 == from`).
/// The sequencer never re-enters `host_pull_events`, so holding the `PULL` borrow here is safe.
fn pull_from_source(source: &SharedNoteEventSource, from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let pull = unsafe { PULL.get() };
    if pull.blocks.is_null() {
        return 0;
    }
    let blocks = unsafe { core::slice::from_raw_parts(pull.blocks, pull.block_count) };
    let block = match blocks.iter().find(|block| block.p0 == from) {
        Some(block) => *block,
        None => return 0
    };
    let sample_rate = pull.sample_rate;
    pull.scratch.clear();
    source.borrow_mut().process_notes(from, to, BlockFlags(flags), &mut |event| pull.scratch.push(event));
    pull.scratch.sort_by(compare_lifecycle);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let mut count = 0;
    for event in &pull.scratch {
        if count >= out.len() {
            break;
        }
        let record = match *event {
            Event::NoteStart {id, position, pitch, cent, velocity, ..} => EventRecord {
                offset: sample_offset(position, &block, sample_rate) as u32,
                kind: EVENT_NOTE_ON,
                id: id as u32,
                pitch: pitch as u32,
                velocity,
                cent
            },
            Event::NoteComplete {id, position, pitch} => EventRecord {
                offset: sample_offset(position, &block, sample_rate) as u32,
                kind: EVENT_NOTE_OFF,
                id: id as u32,
                pitch: pitch as u32,
                velocity: 0.0,
                cent: 0.0
            },
            Event::Update {..} => continue
        };
        out[count] = record;
        count += 1;
    }
    count as u32
}

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
    process_index: u32, // the device's `process` slot in the shared function table
    sample_rate: f32,
    pull_chain: Option<PullLink>, // the top of this unit's event pull chain (sequencer, or a midi-fx over it)
    events: EventBuffer,
    output: SharedAudioBuffer,
    device_output: Box<[f32]>,
    // `device_events` (the event scratch the device pulls into), `device_blocks`, `device_state`, and
    // `out_offsets` are referenced only by raw address inside `descriptor`; they must stay alive (dropping
    // them frees the memory the device reads/writes), so keep the fields even though Rust sees no direct
    // reads. `device_blocks` is refilled from the ProcessInfo each quantum.
    #[allow(dead_code)]
    device_events: Box<[EventRecord]>,
    device_blocks: Box<[BlockRecord]>,
    #[allow(dead_code)]
    device_state: Box<[u32]>, // u32 so the block is 4-aligned for the device's SynthState
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    descriptor: Box<[u32]>
}

impl PluginInstrument {
    fn new(sample_rate: f32, device: DeviceReg) -> Self {
        let device_output = vec![0.0f32; RENDER_QUANTUM].into_boxed_slice();
        let blank = EventRecord {offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
        let device_events = vec![blank; DEVICE_MAX_EVENTS].into_boxed_slice();
        let blank_block = BlockRecord {index: 0, flags: 0, p0: 0.0, p1: 0.0, s0: 0, s1: 0, bpm: 0.0, reserved: 0};
        let device_blocks = vec![blank_block; DEVICE_MAX_BLOCKS].into_boxed_slice();
        let state_size = device.state_size as usize;
        let device_state = vec![0u32; state_size.div_ceil(4)].into_boxed_slice(); // 4-aligned, >= state_size bytes
        let out_offsets = vec![device_output.as_ptr() as u32].into_boxed_slice();
        // descriptor words (see the `abi` layout): frames, in_count/ptr, out_count/ptr, param_count/ptr,
        // state_ptr, in_event_cap/ptr (pull scratch), out_event_cap/ptr (0, instrument has no event out),
        // block_count/ptr, sample_rate (f32 bits).
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            0, 0,
            1, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            DEVICE_MAX_EVENTS as u32, device_events.as_ptr() as u32,
            0, 0,
            0, device_blocks.as_ptr() as u32,
            sample_rate.to_bits()
        ].into_boxed_slice();
        Self {
            process_index: device.process_index,
            sample_rate,
            pull_chain: None,
            events: EventBuffer::new(),
            output: shared_audio_buffer(),
            device_output,
            device_events,
            device_blocks,
            device_state,
            out_offsets,
            descriptor
        }
    }

    fn set_pull_chain(&mut self, chain: PullLink) {
        self.pull_chain = Some(chain);
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
        let mut block_count = 0;
        for block in info.blocks {
            if block_count >= self.device_blocks.len() {
                break;
            }
            self.device_blocks[block_count] = BlockRecord {
                index: block.index,
                flags: block.flags.0,
                p0: block.p0,
                p1: block.p1,
                s0: block.s0 as u32,
                s1: block.s1 as u32,
                bpm: block.bpm,
                reserved: 0
            };
            block_count += 1;
        }
        self.descriptor[0] = RENDER_QUANTUM as u32;
        self.descriptor[12] = block_count as u32;
        // Hand the device its pull context, then call it. The device PULLS its events via host_pull_events.
        // Scope the `PULL.get()` borrow so none is live across `call_device_process` (the device's
        // host_pull_events takes its own `PULL.get()`); single-threaded, so the two never overlap.
        {
            let pull = unsafe { PULL.get() };
            pull.current = self.pull_chain.clone();
            pull.blocks = info.blocks.as_ptr();
            pull.block_count = info.blocks.len();
            pull.sample_rate = self.sample_rate;
        }
        call_device_process(self.process_index, self.descriptor.as_ptr() as u32);
        {
            let pull = unsafe { PULL.get() };
            pull.current = None;
            pull.blocks = core::ptr::null();
            pull.block_count = 0;
        }
        let mut output = self.output.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            let sample = self.device_output[index];
            output.left[index] = sample;
            output.right[index] = sample;
        }
    }
}

/// A graph node that runs an audio-EFFECT device after an upstream node (Route B). It reads its single
/// input buffer (the upstream's mono output, taken from its `left` channel) through the device, into the
/// engine-allocated mono output, then fans that to its stereo output for the next node / the bus. The host
/// owns ordering: a `register_edge(upstream, this)` guarantees the input buffer is fresh when this runs.
/// Pulls no events (a no-param effect), so it never touches `PULL`. All device memory is talc-allocated.
struct PluginAudioEffect {
    process_index: u32,
    events: EventBuffer, // unused (a no-param effect receives no events) but required by `Processor: EventReceiver`
    output: SharedAudioBuffer,
    // The upstream output buffer, kept alive; its `left` address is captured into `in_offsets[0]`. The
    // `Rc<RefCell<AudioBuffer>>` never moves, so the captured pointer stays valid.
    #[allow(dead_code)]
    input: Option<SharedAudioBuffer>,
    device_output: Box<[f32]>,
    in_offsets: Box<[u32]>,
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    #[allow(dead_code)]
    device_state: Box<[u32]>,
    descriptor: Box<[u32]>
}

impl PluginAudioEffect {
    fn new(sample_rate: f32, device: DeviceReg) -> Self {
        let device_output = vec![0.0f32; RENDER_QUANTUM].into_boxed_slice();
        let state_size = device.state_size as usize;
        let device_state = vec![0u32; state_size.div_ceil(4)].into_boxed_slice();
        let in_offsets = vec![0u32].into_boxed_slice(); // input buffer ptr, set by set_audio_source
        let out_offsets = vec![device_output.as_ptr() as u32].into_boxed_slice();
        // descriptor (see `abi`): frames, in_count/ptr (1), out_count/ptr (1), no params, state, no event
        // scratch, no out events, no blocks (the effect ignores sub-block timing for now), sample_rate.
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            1, in_offsets.as_ptr() as u32,
            1, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            0, 0,
            0, 0,
            0, 0,
            sample_rate.to_bits()
        ].into_boxed_slice();
        Self {
            process_index: device.process_index,
            events: EventBuffer::new(),
            output: shared_audio_buffer(),
            input: None,
            device_output,
            in_offsets,
            out_offsets,
            device_state,
            descriptor
        }
    }
}

impl EventReceiver for PluginAudioEffect {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for PluginAudioEffect {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.in_offsets[0] = source.borrow().left.as_ptr() as u32;
        self.input = Some(source);
    }
}

impl AudioGenerator for PluginAudioEffect {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for PluginAudioEffect {
    fn reset(&mut self) {}

    fn process(&mut self, _info: &ProcessInfo) {
        self.descriptor[0] = RENDER_QUANTUM as u32;
        call_device_process(self.process_index, self.descriptor.as_ptr() as u32);
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
    devices: Vec<DeviceReg>,           // loaded device plugins, in load order (the host registers them)
    device_allocs: Vec<Box<[u8]>>,     // talc-owned regions handed to devices (data + stacks); kept alive
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
            devices: Vec::new(),
            device_allocs: Vec::new(),
            controls: Rc::new(Controls::new())
        }
    }

    /// Allocate `size` bytes from talc for a loading device (its relocated data region, or its stack) and
    /// return the address. The block is kept alive for the session (devices live until shutdown), so the
    /// memory the device's `__memory_base` / `__stack_pointer` point at never moves or frees.
    fn device_alloc(&mut self, size: usize) -> u32 {
        let block = vec![0u8; size].into_boxed_slice();
        let ptr = block.as_ptr() as u32;
        self.device_allocs.push(block);
        ptr
    }

    /// Register a loaded device: the table slot holding its `process` and the bytes its state block needs.
    /// Returns the device id (its index). The host calls this once per device, before `bind`.
    fn device_register(&mut self, process_index: u32, state_size: u32, kind: u32) -> u32 {
        let id = self.devices.len() as u32;
        self.devices.push(DeviceReg {process_index, state_size, kind});
        id
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
        // Split the loaded devices by kind. Instruments voice notes; effects transform audio. Order is
        // preserved within each kind, so the page's load order still picks which unit gets which instrument.
        let instruments: Vec<DeviceReg> =
            self.devices.iter().filter(|device| device.kind == DEVICE_KIND_INSTRUMENT).copied().collect();
        let effect = self.devices.iter().find(|device| device.kind == DEVICE_KIND_EFFECT).copied();
        let midi_fx: Vec<DeviceReg> =
            self.devices.iter().filter(|device| device.kind == DEVICE_KIND_MIDI_EFFECT).copied().collect();
        if instruments.is_empty() {
            return; // no instrument plugin loaded -> nothing to voice the notes with
        }
        // One instrument per audio unit. Until the unit's real input instrument device is read from the
        // box, pick the device by the audio unit's `index` field (key 11) modulo the loaded instruments, so
        // the page deterministically controls which unit gets which device (e.g. bass -> sawtooth). When an
        // effect device is loaded, insert it after the BASS only (slot 1 = the saw): instrument -> effect
        // -> master, so the demo contrasts a filtered bass against the dry lead.
        for (unit, regions) in self.bind_note_regions_by_unit() {
            let slot = unit.map(|uuid| self.read_pulses(uuid, 11) as usize).unwrap_or(0) % instruments.len();
            let device = instruments[slot];
            let sequencer: SharedNoteEventSource = Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {regions}))));
            // Build the unit's pull chain: the sequencer at the leaf, then each midi-fx (in load order)
            // folded on top, so the LAST-loaded fx is the instrument's direct upstream. DEMO: only the LEAD
            // (slot 0) gets the midi-fx chain (arp then transpose) -> sequencer <- arp <- transpose <-
            // instrument, so the held chord is arpeggiated and then shifted up an octave; the bass gets none.
            let mut chain = PullLink::Source(sequencer);
            if slot == 0 {
                for fx in &midi_fx {
                    chain = PullLink::MidiFx {
                        process_index: fx.process_index,
                        state: Rc::new(DeviceState::new(fx.state_size as usize)),
                        upstream: Rc::new(chain)
                    };
                }
            }
            let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, device)));
            instrument.borrow_mut().set_pull_chain(chain);
            let instrument_output = instrument.borrow().audio_output();
            let instrument_id = self.context.register_processor(instrument);
            let unit_effect = effect.filter(|_| slot == 1); // DEMO: effect only on the bass (the saw, slot 1)
            match unit_effect {
                Some(effect_device) => {
                    let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, effect_device)));
                    node.borrow_mut().set_audio_source(instrument_output);
                    master.borrow_mut().add_audio_source(node.borrow().audio_output());
                    let effect_id = self.context.register_processor(node);
                    self.context.register_edge(instrument_id, effect_id); // instrument renders before the effect reads it
                    self.context.register_edge(effect_id, master_id); // effect renders before the bus sums it
                }
                None => {
                    master.borrow_mut().add_audio_source(instrument_output);
                    self.context.register_edge(instrument_id, master_id); // instrument renders before the bus sums it
                }
            }
        }
    }

    /// Group every `NoteRegionBox` by its owning audio unit, returning one bound-region list per unit (in
    /// discovery order). The chain is pointer-only: region.regions (key 1) -> the track's regions hub,
    /// track.tracks (key 1) -> the unit's tracks hub. Regions that resolve to no unit are grouped together
    /// (one fallback instrument) so they still sound.
    fn bind_note_regions_by_unit(&mut self) -> Vec<(Option<Uuid>, Vec<(NoteRegion, NoteCollection)>)> {
        let mut bound_per_unit = Vec::new();
        for (unit, members) in group_regions_by_unit(&self.graph) {
            let bound: Vec<(NoteRegion, NoteCollection)> =
                members.into_iter().filter_map(|region_uuid| self.bind_region(region_uuid)).collect();
            if !bound.is_empty() {
                bound_per_unit.push((unit, bound));
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

/// Group note-region uuids by their owning audio unit, in discovery order, returning `(unit, regions)`
/// per group. The chain is pointer-only: region.regions (key 1) -> the track, then track.tracks (key 1)
/// -> the unit. Regions resolving to no unit (orphans) collect into the `None`-keyed group, kept so they
/// still sound. The caller reads the unit (e.g. its `index`) to choose the device. Pure (unit-tested).
fn group_regions_by_unit(graph: &BoxGraph) -> Vec<(Option<Uuid>, Vec<Uuid>)> {
    let region_uuids: Vec<Uuid> = graph.find_all_by_name("NoteRegionBox").iter().map(|region| region.uuid).collect();
    let mut groups: Vec<(Option<Uuid>, Vec<Uuid>)> = Vec::new();
    for region_uuid in region_uuids {
        let unit = unit_of_region(graph, region_uuid);
        match groups.iter_mut().find(|(group_unit, _)| *group_unit == unit) {
            Some((_, members)) => members.push(region_uuid),
            None => groups.push((unit, vec![region_uuid]))
        }
    }
    groups
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
    unsafe { INPUT.get().capacity() }
}

/// Ensure the input scratch can hold `len` bytes, growing it (and keeping the larger buffer) if needed.
/// Returns the buffer's address, which a grow may have moved, so the host must use this result. Cheap when
/// `len` already fits (the common case), so the host can call it before every transaction.
#[no_mangle]
pub extern "C" fn input_reserve(len: usize) -> *mut u8 {
    unsafe {
        let input = INPUT.get();
        if input.capacity() < len {
            input.reserve(len); // len() is always 0 (we read via the ptr, never push), so this targets `len`
        }
        input.as_mut_ptr()
    }
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

/// Reset to a fresh engine with an empty graph, KEEPING the sample rate the engine was created with
/// (call before replaying a fresh session). No-op if `init` has not created the engine yet: the sample
/// rate is only known from creation, so there is nothing to reset to before then.
#[no_mangle]
pub extern "C" fn reset() {
    unsafe {
        if let Some(sample_rate) = ENGINE.get().as_ref().map(|engine| engine.sample_rate) {
            *ENGINE.get() = Some(Engine::new(sample_rate));
        }
        CHECKSUM.get().fill(0);
    }
}

/// Apply one forward-only transaction from the first `len` input bytes, refreshing the checksum
/// buffer. Returns 0 on success, 1 on a decode/apply error or if the engine was not created (`init`).
#[no_mangle]
pub extern "C" fn apply_updates(len: usize) -> i32 {
    unsafe {
        let engine = match ENGINE.get().as_mut() {
            Some(engine) => engine,
            None => return 1 // the engine must be created (with its sample rate) by `init` first
        };
        // Read the bytes the host wrote via the (possibly grown) buffer pointer. The Vec's len stays 0
        // (we never push), so index by the raw ptr; `len` is bounded by the host to the buffer capacity.
        let input = core::slice::from_raw_parts(INPUT.get().as_ptr(), len);
        match engine.apply_updates(input) {
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
        INPUT.get().reserve(INPUT_CAPACITY); // pre-allocate the input scratch (len stays 0; this is capacity)
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

/// Allocate `size` bytes of engine (talc) memory for a loading device and return the address. The host
/// loader uses this for a device's relocated data region (its `__memory_base`) and its stack.
#[no_mangle]
pub extern "C" fn device_alloc(size: u32) -> u32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.device_alloc(size as usize),
            None => 0
        }
    }
}

/// Register a loaded device: `process_index` is its `process` slot in the shared function table,
/// `state_size` the bytes per instance state block, `kind` its `kind` export (instrument / effect).
/// Returns the device id. Call once per device, before `bind` (which builds the graph and wires devices).
#[no_mangle]
pub extern "C" fn device_register(process_index: u32, state_size: u32, kind: u32) -> u32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.device_register(process_index, state_size, kind),
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
        assert_eq!(groups, vec![
            (Some(uuid(0x10)), vec![r1, r2]),
            (Some(uuid(0x20)), vec![r3]),
            (None, vec![r4, r5])
        ]);
    }

    #[test]
    fn empty_graph_yields_no_groups() {
        assert!(group_regions_by_unit(&BoxGraph::from_boxes(Vec::new())).is_empty());
    }
}
