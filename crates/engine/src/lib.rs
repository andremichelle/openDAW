//! The WASM audio-engine module: a downstream `BoxGraph` mirror fed the live FORWARD-only sync
//! stream (`SyncSource` -> worklet/test bridge). JS copies the serialized `UpdateTask[]` into the
//! input buffer, calls `apply_updates(len)`, then reads the 32-byte checksum buffer to compare
//! against the TS source after every transaction.
//!
//! ALLOCATOR: talc (`WasmDynamicTalc`), a reclaiming allocator that grows linear memory via
//! `memory.grow` on demand and frees blocks back for reuse. Single-threaded build, so no lock.

#![cfg_attr(not(test), no_std)]
// The engine is a single-threaded wasm module; its graph/registry/buffers are process globals
// accessed only from the one worklet thread, so the static-mut references here are sound.
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use bindings::note_collection::NoteCollection;
use bindings::value_collection::ValueCollection;
use boxgraph::address::Address;
use boxgraph::boxes::Registry;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::decode_forward;
use processors::buffer::AudioBuffer;
use processors::instrument::SineInstrument;
use processors::sequencer::{NoteRegion, NoteSequencer, TimedNote};
use studio_boxes::registry;
use transport::transport::{Transport, RENDER_QUANTUM};

mod metronome;
use metronome::Metronome;

const INPUT_CAPACITY: usize = 1 << 20; // 1 MiB scratch for one transaction's update bytes

static mut INPUT: [u8; INPUT_CAPACITY] = [0; INPUT_CAPACITY];
static mut CHECKSUM: [u8; 32] = [0; 32];
static mut GRAPH: Option<BoxGraph> = None;
static mut REGISTRY: Option<Registry> = None;
static mut TRANSPORT: Option<Transport> = None;
static mut METRONOME: Option<Metronome> = None;
static mut OUTPUT: [f32; RENDER_QUANTUM * 2] = [0.0; RENDER_QUANTUM * 2];
static mut TEMPO: Option<ValueCollection> = None;
static mut TEMPO_AUTOMATION_ENABLED: bool = true; // TimelineBox.tempoTrack.enabled

// Note playback: a sequencer + sine instrument fed by a note region + its NoteCollection (bound from
// the first NoteRegionBox in the project). The instrument renders into NOTE_BUFFER, mixed into OUTPUT.
static mut NOTE_SEQUENCER: Option<NoteSequencer> = None;
static mut INSTRUMENT: Option<SineInstrument> = None;
static mut NOTES: Option<NoteCollection> = None;
static mut NOTE_REGION: Option<NoteRegion> = None;
static mut NOTE_BUFFER: AudioBuffer = AudioBuffer {left: [0.0; RENDER_QUANTUM], right: [0.0; RENDER_QUANTUM]};
static mut NOTE_EVENTS: Vec<TimedNote> = Vec::new();

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
static mut ENGINE_STATE: [u8; ENGINE_STATE_LEN] = [0; ENGINE_STATE_LEN];

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    unsafe { INPUT.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn input_capacity() -> usize {
    INPUT_CAPACITY
}

#[no_mangle]
pub extern "C" fn checksum_ptr() -> *const u8 {
    unsafe { CHECKSUM.as_ptr() }
}

/// Reset to an empty graph (call before replaying a fresh session).
#[no_mangle]
pub extern "C" fn reset() {
    unsafe {
        GRAPH = Some(BoxGraph::from_boxes(Vec::new()));
        REGISTRY = Some(registry());
        CHECKSUM = [0; 32];
    }
}

/// Apply one forward-only transaction from the first `len` input bytes, then refresh the checksum
/// buffer. Returns 0 on success, 1 on a decode/apply error.
#[no_mangle]
pub extern "C" fn apply_updates(len: usize) -> i32 {
    unsafe {
        if GRAPH.is_none() {
            reset();
        }
        let graph = GRAPH.as_mut().unwrap();
        let registry = REGISTRY.as_ref().unwrap();
        let mut reader = ByteReader::new(&INPUT[..len]);
        let updates = match decode_forward(&mut reader) {
            Ok(updates) => updates,
            Err(_) => return 1
        };
        if graph.transaction(&updates, registry).is_err() {
            return 1;
        }
        CHECKSUM = graph.checksum();
        // the tempo cache updates itself inside `transaction` (its subscription observers run on the
        // committed graph), so there is nothing to refresh here.
        0
    }
}

/// Initialize the engine for `sample_rate`: empty graph, a playing transport, and a metronome.
#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    reset();
    unsafe {
        let mut transport = Transport::new(sample_rate, 120.0);
        transport.play();
        TRANSPORT = Some(transport);
        METRONOME = Some(Metronome::new(sample_rate));
        NOTE_SEQUENCER = Some(NoteSequencer::new(sample_rate));
        INSTRUMENT = Some(SineInstrument::new(sample_rate));
    }
}

/// Render one 128-frame quantum into the output buffer (planar: left channel then right). Drives the
/// transport block loop (tempo automation + loop wrap), mixing metronome clicks per sub-block while
/// playing; silence when stopped. Always refreshes the EngineState back-channel afterwards.
#[no_mangle]
pub extern "C" fn render() {
    unsafe {
        for sample in OUTPUT.iter_mut() {
            *sample = 0.0
        }
        if let (Some(transport), Some(metronome)) = (TRANSPORT.as_mut(), METRONOME.as_mut()) {
            if transport.is_playing() {
                NOTE_BUFFER.clear();
                // use the tempo map only when automation is enabled and non-empty, else the fixed bpm
                let events = if TEMPO_AUTOMATION_ENABLED { TEMPO.as_ref().map(|tempo| tempo.events()) } else { None };
                let active = events.as_deref().filter(|collection| !collection.is_empty());
                transport.render_quantum(active, |block| {
                    let (left, right) = OUTPUT.split_at_mut(RENDER_QUANTUM);
                    metronome.process(block, &mut left[block.s0..block.s1], &mut right[block.s0..block.s1]);
                    render_notes(block)
                });
                // mix the instrument's stereo buffer (filled per sub-block) into the planar output
                for index in 0..RENDER_QUANTUM {
                    OUTPUT[index] += NOTE_BUFFER.left[index];
                    OUTPUT[RENDER_QUANTUM + index] += NOTE_BUFFER.right[index];
                }
            }
        }
        if let Some(transport) = TRANSPORT.as_ref() {
            write_engine_state(transport);
        }
    }
}

/// Sequence the note region for `block` and render the resulting notes into NOTE_BUFFER. A no-op until
/// a note region has been bound. (v1: the region's own loop drives repetition; transport-loop wrap
/// discontinuity for notes spanning the wrap is a later refinement.)
fn render_notes(block: &transport::transport::Block) {
    unsafe {
        if let (Some(sequencer), Some(notes), Some(instrument), Some(region)) =
            (NOTE_SEQUENCER.as_mut(), NOTES.as_ref(), INSTRUMENT.as_mut(), NOTE_REGION.as_ref())
        {
            NOTE_EVENTS.clear();
            {
                let collection = notes.events();
                sequencer.process(region, &collection, block, true, false, &mut NOTE_EVENTS);
            }
            NOTE_EVENTS.sort_by_key(|timed| timed.offset);
            instrument.process(&NOTE_EVENTS, &mut NOTE_BUFFER, block.s0, block.s1);
        }
    }
}

/// Serialize the current transport state into the EngineState buffer (big-endian, per the contract).
fn write_engine_state(transport: &Transport) {
    unsafe {
        ENGINE_STATE[STATE_POSITION..STATE_POSITION + 4].copy_from_slice(&(transport.position() as f32).to_be_bytes());
        ENGINE_STATE[STATE_BPM..STATE_BPM + 4].copy_from_slice(&transport.bpm().to_be_bytes());
        ENGINE_STATE[STATE_PLAYBACK_TIMESTAMP..STATE_PLAYBACK_TIMESTAMP + 4].copy_from_slice(&0f32.to_be_bytes());
        ENGINE_STATE[STATE_COUNT_IN_REMAINING..STATE_COUNT_IN_REMAINING + 4].copy_from_slice(&0f32.to_be_bytes());
        ENGINE_STATE[STATE_IS_PLAYING] = transport.is_playing() as u8;
        ENGINE_STATE[STATE_IS_COUNTING_IN] = 0;
        ENGINE_STATE[STATE_IS_RECORDING] = 0;
        ENGINE_STATE[STATE_PERF_INDEX..STATE_PERF_INDEX + 4].copy_from_slice(&0i32.to_be_bytes());
    }
}

#[no_mangle]
pub extern "C" fn engine_state_ptr() -> *const u8 {
    unsafe { ENGINE_STATE.as_ptr() }
}

#[no_mangle]
pub extern "C" fn engine_state_len() -> usize {
    ENGINE_STATE_LEN
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const f32 {
    unsafe { OUTPUT.as_ptr() }
}

#[no_mangle]
pub extern "C" fn output_len() -> usize {
    RENDER_QUANTUM * 2
}

#[no_mangle]
pub extern "C" fn play() {
    unsafe {
        if let Some(transport) = TRANSPORT.as_mut() {
            transport.play()
        }
    }
}

#[no_mangle]
pub extern "C" fn stop() {
    unsafe {
        if let Some(transport) = TRANSPORT.as_mut() {
            transport.stop(false)
        }
    }
}

#[no_mangle]
pub extern "C" fn set_metronome_enabled(enabled: i32) {
    unsafe {
        if let Some(metronome) = METRONOME.as_mut() {
            metronome.set_enabled(enabled != 0)
        }
    }
}

/// After the project has synced, bind the transport bpm and metronome signature to the live
/// `TimelineBox`: catch up the current values, then subscribe so future edits apply immediately
/// (each update carries the new value). Returns 0 on success, 1 if no TimelineBox is present.
#[no_mangle]
pub extern "C" fn bind() -> i32 {
    unsafe {
        let graph = match GRAPH.as_mut() {
            Some(graph) => graph,
            None => return 1
        };
        let uuid = match graph.find_by_name("TimelineBox") {
            Some(timeline) => timeline.uuid,
            None => return 1
        };
        graph.catchup_and_subscribe(Address::of(uuid, vec![31]), |value| {
            if let Some(bpm) = value.as_float32() {
                if let Some(transport) = TRANSPORT.as_mut() {
                    transport.set_bpm(bpm)
                }
            }
        });
        // tempo automation on/off: TimelineBox.tempoTrack (22).enabled (20).
        graph.catchup_and_subscribe(Address::of(uuid, vec![22, 20]), |value| {
            if let Some(enabled) = value.as_bool() {
                TEMPO_AUTOMATION_ENABLED = enabled
            }
        });
        graph.catchup_and_subscribe(Address::of(uuid, vec![10, 1]), |value| {
            if let Some(nominator) = value.as_int32() {
                if let Some(metronome) = METRONOME.as_mut() {
                    metronome.set_nominator(nominator as u32)
                }
            }
        });
        graph.catchup_and_subscribe(Address::of(uuid, vec![10, 2]), |value| {
            if let Some(denominator) = value.as_int32() {
                if let Some(metronome) = METRONOME.as_mut() {
                    metronome.set_denominator(denominator as u32)
                }
            }
        });
        // loop area: TimelineBox.loopArea (11) = {enabled (1, bool), from (2, i32), to (3, i32) pulses}.
        graph.catchup_and_subscribe(Address::of(uuid, vec![11, 1]), |value| {
            if let Some(enabled) = value.as_bool() {
                if let Some(transport) = TRANSPORT.as_mut() {
                    transport.set_loop_enabled(enabled)
                }
            }
        });
        graph.catchup_and_subscribe(Address::of(uuid, vec![11, 2]), |value| {
            if let Some(from) = value.as_int32() {
                if let Some(transport) = TRANSPORT.as_mut() {
                    transport.set_loop_from(from as f64)
                }
            }
        });
        graph.catchup_and_subscribe(Address::of(uuid, vec![11, 3]), |value| {
            if let Some(to) = value.as_int32() {
                if let Some(transport) = TRANSPORT.as_mut() {
                    transport.set_loop_to(to as f64)
                }
            }
        });
        // observe the tempo-automation collection: TimelineBox.tempoTrack (22).events (1) points at
        // the ValueEventCollectionBox.owners. ValueCollection caches + rebuilds only on relevant change.
        let tempo_collection = graph.target_of(&Address::of(uuid, vec![22, 1])).map(|target| target.uuid);
        if let Some(collection) = tempo_collection {
            TEMPO = Some(ValueCollection::observe(graph, collection));
        }
        bind_note_region(graph);
        0
    }
}

/// If the project has a `NoteRegionBox`, read its loopable span (position 10, duration 11,
/// loopOffset 12, loopDuration 13) and observe the `NoteEventCollectionBox` its `events` pointer
/// (key 2) targets, so the sequencer can play the region's notes.
unsafe fn bind_note_region(graph: &mut BoxGraph) {
    let region_uuid = match graph.find_by_name("NoteRegionBox") {
        Some(region) => region.uuid,
        None => return
    };
    let read = |key: u16| graph.field_value(&Address::of(region_uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64;
    let region = NoteRegion {position: read(10), duration: read(11), loop_offset: read(12), loop_duration: read(13)};
    NOTE_REGION = Some(region);
    if let Some(collection) = graph.target_of(&Address::of(region_uuid, vec![2])).map(|target| target.uuid) {
        NOTES = Some(NoteCollection::observe(graph, collection));
    }
}

// Dynamic heap: talc claims linear memory via `memory.grow` on demand (no fixed arena) and reclaims
// freed blocks. Single-threaded wasm, so we wrap the non-Sync `TalcCell` and assert `Sync` (exactly
// what talc's own `TalcSyncCell` does), but keep the inner cell reachable so we can read counters,
// which `TalcSyncCell` does not expose.
#[cfg(all(not(target_feature = "atomics"), target_family = "wasm"))]
mod heap {
    use core::alloc::{GlobalAlloc, Layout};
    use talc::cell::TalcCell;
    use talc::wasm::{WasmBinning, WasmGrowAndClaim};

    struct EngineAlloc(TalcCell<WasmGrowAndClaim, WasmBinning>);

    // SAFETY: the engine wasm is single-threaded (no atomics), so there is never concurrent access.
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
