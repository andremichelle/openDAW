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
use bindings::value_collection::ValueCollection;
use boxgraph::address::Address;
use boxgraph::boxes::Registry;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::decode_forward;
use studio_boxes::registry;
use transport::transport::{Transport, RENDER_QUANTUM};
use value::value::value_at;

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
    }
}

/// Render one 128-frame quantum into the output buffer (planar: left channel then right). Advances
/// the transport and mixes metronome clicks while playing; silence when stopped.
#[no_mangle]
pub extern "C" fn render() {
    unsafe {
        for sample in OUTPUT.iter_mut() {
            *sample = 0.0
        }
        if !TRANSPORT.as_ref().is_some_and(|transport| transport.is_playing()) {
            return;
        }
        if let (Some(transport), Some(metronome)) = (TRANSPORT.as_mut(), METRONOME.as_mut()) {
            // tempo automation: a non-empty tempo map overrides the fixed bpm at the quantum start
            // (per-quantum is finer than the TS 80-pulse grid, so no sub-block split is needed here).
            if let Some(tempo) = TEMPO.as_ref() {
                let events = tempo.events();
                if !events.is_empty() {
                    let bpm = value_at(&events, transport.position(), transport.bpm());
                    transport.set_bpm(bpm);
                }
            }
            let block = transport.process_quantum();
            let (left, right) = OUTPUT.split_at_mut(RENDER_QUANTUM);
            metronome.process(&block, left, right);
        }
    }
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
        // observe the tempo-automation collection: TimelineBox.tempoTrack (22).events (1) points at
        // the ValueEventCollectionBox.owners. ValueCollection caches + rebuilds only on relevant change.
        let tempo_collection = graph.target_of(&Address::of(uuid, vec![22, 1])).map(|target| target.uuid);
        if let Some(collection) = tempo_collection {
            TEMPO = Some(ValueCollection::observe(graph, collection));
        }
        0
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
