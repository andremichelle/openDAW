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
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell, UnsafeCell};
use bindings::indexed_collection::IndexedCollection;
use bindings::value_collection::ValueCollection;
use boxgraph::address::Address;
use boxgraph::boxes::Registry;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::{decode_forward, Update};
use abi::{EventRecord, ParamChange, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::engine_context::{EngineContext, NodeId};
use engine_env::event::Event;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::ppqn::pulses_to_samples;
use engine_env::process_info::ProcessInfo;
use studio_boxes::registry;
use transport::transport::{Transport, RENDER_QUANTUM};

// Devices are PIC side modules the host loads at runtime, each at a talc-assigned base, and installs
// into the ONE shared `__indirect_function_table` (the engine is built `--import-table`). The engine
// keeps a small registry of loaded devices and calls each device's `process(desc_ptr)` by its table slot
// via `call_indirect` — wasm-to-wasm, zero copy. The host loader fills the registry through the
// `device_register` export and allocates device data + stacks through `device_alloc`.
#[derive(Clone, Copy)]
struct DeviceReg {
    process_index: u32,            // slot in the shared function table holding the device's `process`
    state_size: u32,               // bytes the engine must allocate (zeroed) per instance
    kind: u32,                     // DEVICE_KIND_INSTRUMENT / DEVICE_KIND_AUDIO_EFFECT (from the `kind` export)
    init_index: u32,               // slot of the device's `init` export (binds params); 0 if it has none
    parameter_changed_index: u32,  // slot of the device's `parameter_changed` export; 0 if it has none
    field_changed_index: u32,      // slot of the device's `field_changed` export (observed plain fields); 0 if none
    sample_changed_index: u32      // slot of the device's `sample_changed` export (observed samples); 0 if none
}

/// A registered COMPOSITE box type (e.g. Playfield): a device box that hosts a CHILD COLLECTION of its own
/// instruments rather than a single DSP. The engine learns this as data (registered like a device box type),
/// so it stays mapping-agnostic — no composite box name or field key is hardcoded. `children_field` is the
/// host field whose pointer hub holds the children; `index_key` is the child box field their order / routing
/// reads. Each child is realized generically by its OWN box type (a leaf device, or a nested composite).
#[derive(Clone)]
pub(crate) struct CompositeSpec {
    box_type: String,
    pub(crate) children_field: u16,
    pub(crate) index_key: u16,
    pub(crate) exclude_key: u16 // a child's choke-group flag field (0 = the composite has no choke groups)
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

// Call a device's `init(state_ptr, sample_rate)` export (it binds its parameters via `host_bind_parameter`
// and learns the engine's sample rate, stable for its life). Same table-index-is-fn-pointer trick. Called
// once when the device is wired, NOT during render.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_init(init_index: u32, state_ptr: u32, sample_rate: f32) {
    if init_index == 0 {
        return; // the device exports no `init`; index 0 is the "none" sentinel
    }
    let init: extern "C" fn(u32, f32) = unsafe { core::mem::transmute(init_index as usize) };
    init(state_ptr, sample_rate);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_init(_init_index: u32, _state_ptr: u32, _sample_rate: f32) {}

// Call a device's `parameter_changed(state_ptr, id, value)` export to push a resolved parameter value. The
// engine calls this at build / edit time (never during the device's `process`, so it never aliases the
// state the render path borrows).
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_parameter_changed(parameter_changed_index: u32, state_ptr: u32, id: u32, kind: u32, value: f32) {
    if parameter_changed_index == 0 {
        return; // the device exports no `parameter_changed`; index 0 is the "none" sentinel
    }
    let parameter_changed: extern "C" fn(u32, u32, u32, f32) = unsafe { core::mem::transmute(parameter_changed_index as usize) };
    parameter_changed(state_ptr, id, kind, value);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_parameter_changed(_parameter_changed_index: u32, _state_ptr: u32, _id: u32, _kind: u32, _value: f32) {}

// Call a device's `field_changed(state_ptr, id, value)` export to deliver an observed plain field's value
// (catch-up + edits). Called only inside a transaction (the `catchup_and_subscribe` callback), never during
// `process`, so it never aliases the state the render path borrows.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_field_changed(field_changed_index: u32, state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    if field_changed_index == 0 {
        return; // the device exports no `field_changed`; index 0 is the "none" sentinel
    }
    let field_changed: extern "C" fn(u32, u32, u32, u32, u32) = unsafe { core::mem::transmute(field_changed_index as usize) };
    field_changed(state_ptr, id, kind, bits, len);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_field_changed(_field_changed_index: u32, _state_ptr: u32, _id: u32, _kind: u32, _bits: u32, _len: u32) {}

// Call a device's `sample_changed(state_ptr, id, handle, present)` export to deliver an observed sample (the
// resolved handle, or `present == 0` when the pointer is unbound). Called only inside a transaction (the
// pointer observer), never during `process`.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_sample_changed(sample_changed_index: u32, state_ptr: u32, id: u32, handle: u32, present: u32) {
    if sample_changed_index == 0 {
        return; // the device exports no `sample_changed`; index 0 is the "none" sentinel
    }
    let sample_changed: extern "C" fn(u32, u32, u32, u32) = unsafe { core::mem::transmute(sample_changed_index as usize) };
    sample_changed(state_ptr, id, handle, present);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_sample_changed(_sample_changed_index: u32, _state_ptr: u32, _id: u32, _handle: u32, _present: u32) {}

const DEVICE_MAX_EVENTS: usize = 256; // per-quantum event scratch the device pulls into
// The `index` field of an EFFECT device box (DeviceFactory's midi-effect / audio-effect attributes), giving
// the chain order within a host. ONLY effects have it: an instrument box has no `index` (its key 2 is `label`),
// and a composite child (e.g. a PlayfieldSampleBox slot) carries its own index at its own key (the composite's
// `index_key`, not this). So this is used solely for the midi / audio effect chains.
const EFFECT_INDEX_KEY: u16 = 2;

mod metronome;
use metronome::Metronome;
mod plugin_instrument;
mod plugin_audio_effect;
mod plugin_midi_effect;
use plugin_midi_effect::PluginMidiEffect; // named in the PullLink::MidiFx variant defined here
mod audio_unit;
use audio_unit::{AudioUnitBinding, DeviceParams, Members};
mod composite;
mod param_automation;
use param_automation::ParamHandle;
mod sample;
use sample::SampleResource;

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
// The bind recorder the `host_bind_parameter` export appends to: each parameter's field path. The engine
// clears it, calls a device's `init` (which binds its params), then drains it and observes each. Held in its
// OWN cell (NOT `ENGINE`), so the re-entrant `host_bind_parameter` call never aliases the `&mut Engine`.
static BIND: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());
// The sample resource (Route F): decoded frames resident in shared memory, keyed by AudioFileBox uuid. Held
// in its OWN cell (NOT `ENGINE`) so a device's re-entrant `host_resolve_sample` call during render never
// aliases the `&mut Engine` the render path holds. Mutated only off-render (the load handshake + box
// observer), read-only during render, so the single-threaded engine never overlaps a borrow.
static SAMPLES: Shared<SampleResource> = Shared::new(SampleResource::new());
// The sample-observe recorder the `host_observe_sample` export appends to: each device's sample pointer-field
// path (e.g. Nano's `file` at `[15]`). After `init`, the engine REACTIVELY tracks each pointer (catch-up +
// subscribe), resolving its target to the AudioFileBox, requesting its frames, and delivering the handle (or
// "unbound") to the device via `sample_changed`. Its OWN cell (NOT `ENGINE`) so the re-entrant
// `host_observe_sample` call from `init` never aliases `&mut Engine`.
static SAMPLE_OBS: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());

// The field-observe recorder the `host_observe_field` export appends to: each device's PLAIN box-field path it
// wants to track (e.g. a Playfield slot's `index` at `[15]`). After `init`, the engine `catchup_and_subscribe`s
// each path and delivers values through the device's `field_changed` export. Its own cell (NOT `ENGINE`) so the
// re-entrant `host_observe_field` call from `init` never aliases `&mut Engine`.
static FIELD_OBS: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());

/// One link in a unit's event PULL CHAIN (the `NoteEventSource` chain, sequencer -> fx -> ... -> the
/// instrument that consumes it). A leaf `Source` is the note sequencer; a `MidiFx` wraps a
/// `PluginMidiEffect` (a MIDI-effect device bridge) over its `upstream` link. Cheap to clone (`Rc`
/// handles); clones of a `MidiFx` share the one `PluginMidiEffect`, hence the one instance state. A MIDI fx
/// is NOT an audio-graph node, it is a pull link (plan §4).
#[derive(Clone)]
enum PullLink {
    Source(SharedNoteEventSource),
    // A composite child's choke injector over a shared note source: pass every note through (the child device
    // filters to its own note), and ADD a `CHOKE` record when a note in `choke` (its sibling choke group) fires.
    // A leaf link like `Source`. `choke` is an `Rc` so cloning the link (each pull) does not allocate.
    SlotRoute { upstream: SharedNoteEventSource, choke: Rc<[i32]> },
    MidiFx { effect: Rc<PluginMidiEffect>, upstream: Rc<PullLink> }
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
    scratch: Vec<Event>,
    // Route D automation. `params` is the CURRENT device's bound parameters, swapped in by the node (or the
    // MIDI-fx descent) before its `process` so `host_update_parameters` can resolve + diff them with no
    // alloc. `clock_armed` is set when that device has an automated parameter, so `host_next_update_position`
    // returns real grid points (and the render fragments); otherwise it returns INFINITY (no fragmentation).
    params: Vec<ParamHandle>,
    clock_armed: bool
}

impl PullContext {
    const fn new() -> Self {
        Self {
            current: None, blocks: core::ptr::null(), block_count: 0, sample_rate: 0.0, scratch: Vec::new(),
            params: Vec::new(), clock_armed: false
        }
    }
}

// Order the device's input event stream: by position, and at an EQUAL position by kind priority
// note-off -> param-update -> note-on. So a note ending at a position releases first, the automated
// parameter is then updated, and a note starting there sees the new value (the confirmed tie-break).
// Extends TS `NoteLifecycleEvent.Comparator` (which only ranks note-off before note-on) with the clock
// update events the pulled stream also carries.
fn compare_lifecycle(a: &Event, b: &Event) -> core::cmp::Ordering {
    match a.position().partial_cmp(&b.position()) {
        Some(core::cmp::Ordering::Equal) | None => lifecycle_rank(a).cmp(&lifecycle_rank(b)),
        Some(order) => order
    }
}

fn lifecycle_rank(event: &Event) -> u8 {
    match event {
        Event::NoteComplete {..} => 0, // note-off first
        Event::Update {..} => 1,       // then the param-update (clock tick)
        Event::NoteStart {..} => 2     // then note-on, so it sees the updated parameter
    }
}

/// Host import the device calls (wasm-to-wasm via the loader binding) to PULL its own input events for the
/// pulse range `[from, to)`. It resolves the CURRENT pull link: a leaf sequencer resolves + converts to
/// sample-offset `EventRecord`s directly; a MIDI-fx link descends (routing the fx device's own upstream
/// pull to the next link) and invokes that device's `process_events`. Reads only `PULL`, never `ENGINE`,
/// so it is safe to call re-entrantly from inside `render`.
#[no_mangle]
pub extern "C" fn host_pull_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let link = { unsafe { PULL.get() }.current.clone() };
    match link {
        Some(PullLink::Source(ref source)) => pull_from_source(source, from, to, flags, out_ptr, max),
        Some(PullLink::SlotRoute {ref upstream, ref choke}) => pull_from_slot_route(upstream, choke, from, to, flags, out_ptr, max),
        Some(PullLink::MidiFx {effect, upstream}) => {
            // Descend into the fx: swap in ITS params + clock-armed state + the upstream link, so the fx's own
            // `host_update_parameters` / `next_update_position` see the fx's automation and its upstream pull
            // resolves the next link; run it; then restore the consumer's context. Scope every `PULL.get()`
            // and `RefCell` borrow so none is held across `process_events` (it re-enters both); single-threaded.
            let saved_armed = {
                let pull = unsafe { PULL.get() };
                let saved = pull.clock_armed;
                effect.swap_params(&mut pull.params);
                pull.clock_armed = effect.clock_armed();
                pull.current = Some((*upstream).clone());
                saved
            };
            let count = effect.process_events(from, to, flags, out_ptr, max);
            {
                let pull = unsafe { PULL.get() };
                effect.swap_params(&mut pull.params);
                pull.clock_armed = saved_armed;
                pull.current = Some(PullLink::MidiFx {effect, upstream});
            }
            count
        }
        None => 0
    }
}

/// Host import a render template calls to SEED its fragment loop: the first update position at or AFTER `at`
/// (INCLUSIVE), so a grid point exactly on a block's start fires (mirrors TS `Fragmentor`'s `ceil`). Returns
/// `f64::INFINITY` when the CURRENT device has no automated parameter. Reads only `PULL`.
#[no_mangle]
pub extern "C" fn host_first_update_position(at: f64) -> f64 {
    let pull = unsafe { PULL.get() };
    if !pull.clock_armed {
        return f64::INFINITY;
    }
    // The smallest grid multiple at or above `at` (no libm: truncate toward zero, then step up if below).
    let floored = ((at / UPDATE_CLOCK_RATE) as i64) as f64 * UPDATE_CLOCK_RATE;
    if floored < at { floored + UPDATE_CLOCK_RATE } else { floored }
}

/// Host import a render template calls to ADVANCE its fragment loop: the next update position STRICTLY after
/// `after` — the engine's update-clock policy (a fixed grid today; the one place to make it tempo-aware).
/// Strict so the loop always moves forward. Returns `f64::INFINITY` when the CURRENT device has no automated
/// parameter, so its render simply does not fragment. Reads only `PULL` (the current device's clock-armed
/// state, set by its node / the fx descent).
#[no_mangle]
pub extern "C" fn host_next_update_position(after: f64) -> f64 {
    let pull = unsafe { PULL.get() };
    if !pull.clock_armed {
        return f64::INFINITY;
    }
    // The smallest grid multiple strictly greater than `after` (no libm: truncate toward zero, then step).
    let mut position = ((after / UPDATE_CLOCK_RATE) as i64 + 1) as f64 * UPDATE_CLOCK_RATE;
    if position <= after {
        position += UPDATE_CLOCK_RATE;
    }
    position
}

/// Host import a device calls from its `init` to register a parameter by its FIELD-KEY PATH (`path_ptr`/
/// `path_len`, a `u16` slice in the device's memory — the stable schema keys, no encoding). It only RECORDS
/// the path (into `BIND`) and returns the id (the index); the engine observes the field + track after `init`
/// returns. The host stays mapping-agnostic. Touches no graph and no `&mut Engine`, so it is safe to call
/// re-entrantly from `init`.
#[no_mangle]
pub extern "C" fn host_bind_parameter(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let bind = unsafe { BIND.get() };
    bind.push(path.to_vec());
    (bind.len() - 1) as u32
}

/// Host import a device calls from its `init` to OBSERVE its SAMPLE reference by the box pointer-field PATH
/// (e.g. `[15]` for Nano's `file`). It only RECORDS the path (into `SAMPLE_OBS`) and returns its id; after
/// `init` the engine reactively tracks the pointer, resolving + requesting the sample and delivering the handle
/// via `sample_changed`. Touches no graph and no `&mut Engine`, so it is safe from `init`.
#[no_mangle]
pub extern "C" fn host_observe_sample(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let obs = unsafe { SAMPLE_OBS.get() };
    obs.push(path.to_vec());
    obs.len() as u32 - 1
}

/// Host import a device calls from its `init` to OBSERVE one of its plain box fields by its field-key PATH.
/// Only RECORDS the path (into `FIELD_OBS`) and returns its id; after `init` the engine `catchup_and_subscribe`s
/// it and delivers the value through the device's `field_changed`. NOT a parameter (no automation). Touches no
/// `&mut Engine`, so it is safe from `init`.
#[no_mangle]
pub extern "C" fn host_observe_field(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let obs = unsafe { FIELD_OBS.get() };
    obs.push(path.to_vec());
    obs.len() as u32 - 1
}

/// Host import a device calls (on a clock event) to pull its AUTOMATED parameters that changed at `position`.
/// For each parameter with an automation track, the engine resolves its value, diffs against the last value
/// it handed out, and writes the changed `(id, value)` into `out` (a `ParamChange` scratch in the device's
/// memory), returning the count. Static parameters are pushed at build / edit time, not here. Reads only
/// `PULL` (the current device's params, swapped in by its node), so it is safe to call from inside `process`.
#[no_mangle]
pub extern "C" fn host_update_parameters(position: f64, out_ptr: u32, max: u32) -> u32 {
    let pull = unsafe { PULL.get() };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut ParamChange, max as usize) };
    let mut count = 0;
    for param in &pull.params {
        if param.track.is_none() {
            continue; // static params are not clock-driven; their value is pushed at build / edit
        }
        let (value, kind) = param.resolve(position);
        if value != param.last.get() {
            param.last.set(value);
            if count >= out.len() {
                break;
            }
            out[count] = ParamChange {id: param.id, kind, value};
            count += 1;
        }
    }
    count as u32
}

// WASM CONTRACT: the update-clock grid, mirror of lib-dsp `UpdateClockRate = PPQN.fromSignature(1, 384)` =
// floor(3840 / 384) = 10 pulses. The engine owns this rate in `host_next_update_position` (so it can become
// tempo-aware); every automated device fragments on the same absolute grid, switching its params together.
const UPDATE_CLOCK_RATE: f64 = 10.0;

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

/// Resolve a leaf note source for `[from, to)`: pull its events, lifecycle-sort them, and write each as an
/// `EventRecord` carrying its PULSE `position` (the consumer resolves the sample offset later, via
/// `host_pulse_to_offset`). No block lookup, so an arbitrary (e.g. groove-unwarped) range resolves fine.
/// The sequencer never re-enters `host_pull_events`, so holding the `PULL` borrow here is safe.
fn pull_from_source(source: &SharedNoteEventSource, from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let pull = unsafe { PULL.get() };
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
                position,
                offset: 0,
                kind: EVENT_NOTE_ON,
                id: id as u32,
                pitch: pitch as u32,
                velocity,
                cent
            },
            Event::NoteComplete {id, position, pitch} => EventRecord {
                position,
                offset: 0,
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

/// Resolve a composite child's choke injector: pull the unit's full note stream and pass every note through
/// (the child DEVICE filters to its own note, by the `index` it observed), ADDING a `CHOKE` record when a note
/// in this child's choke group (`choke`) fires. The choke is emitted just before that note (and the device
/// re-sorts CHOKE before note-on anyway), so the child's voices release before any simultaneous own note. Same
/// layering as `pull_from_source`. Used only for a child that is in a choke group; others use `Source`.
fn pull_from_slot_route(upstream: &SharedNoteEventSource, choke: &[i32], from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let pull = unsafe { PULL.get() };
    pull.scratch.clear();
    upstream.borrow_mut().process_notes(from, to, BlockFlags(flags), &mut |event| pull.scratch.push(event));
    pull.scratch.sort_by(compare_lifecycle);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let mut count = 0;
    for event in &pull.scratch {
        if count >= out.len() {
            break;
        }
        match *event {
            Event::NoteStart {id, position, pitch, cent, velocity, ..} => {
                if choke.contains(&(pitch as i32)) {
                    out[count] = EventRecord {position, offset: 0, kind: EVENT_CHOKE, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
                    count += 1;
                    if count >= out.len() {
                        break;
                    }
                }
                out[count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id: id as u32, pitch: pitch as u32, velocity, cent};
            }
            Event::NoteComplete {id, position, pitch} => {
                out[count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: id as u32, pitch: pitch as u32, velocity: 0.0, cent: 0.0};
            }
            Event::Update {..} => continue
        }
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

/// The sample offset within the quantum for a note at pulse `position`, clamped to the block.
fn sample_offset(position: f64, block: &Block, sample_rate: f32) -> usize {
    let pulses = position - block.p0;
    let (s0, s1) = (block.s0 as usize, block.s1 as usize);
    let raw = if pulses.abs() < 1.0e-7 {
        s0
    } else {
        s0 + pulses_to_samples(pulses, block.bpm, sample_rate) as usize
    };
    raw.clamp(s0, s1)
}

struct Engine {
    graph: BoxGraph,
    registry: Registry,
    transport: Transport,
    metronome: Metronome,
    tempo: Option<ValueCollection>,
    context: EngineContext,
    output_bus: Option<SharedAudioBuffer>,
    master: Option<Rc<RefCell<AudioBusProcessor>>>, // the output bus, retained so units wire into it live
    master_id: NodeId,
    audio_units: Vec<AudioUnitBinding>, // one per connected AudioUnitBox, maintained reactively
    unit_changes: Rc<RefCell<Members>>, // recorded by the audio-units membership observer, drained by reconcile
    output_audio: Option<IndexedCollection>, // THE output unit's audio-fx chain (built once at bind, see output_strip)
    output_device_params: Vec<DeviceParams>, // the output-fx devices' bound params, retained so they stay observed
    sample_rate: f32,
    blocks: Vec<Block>,
    devices: Vec<DeviceReg>,           // loaded device plugins, in load order (the host registers them)
    device_box_types: Vec<(String, usize)>, // box-type name -> index into `devices`: the ONLY device glue.
    composites: Vec<CompositeSpec>,    // registered composite box types (host of a child collection); data, not code
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
            master: None,
            master_id: 0,
            audio_units: Vec::new(),
            unit_changes: Rc::new(RefCell::new(Members::default())),
            output_audio: None,
            output_device_params: Vec::new(),
            sample_rate,
            blocks: Vec::new(),
            devices: Vec::new(),
            device_box_types: Vec::new(),
            composites: Vec::new(),
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
    #[allow(clippy::too_many_arguments)] // one slot per device export; positional to match the loader's call
    fn device_register(&mut self, process_index: u32, state_size: u32, kind: u32, init_index: u32, parameter_changed_index: u32, field_changed_index: u32, sample_changed_index: u32) -> u32 {
        let id = self.devices.len() as u32;
        self.devices.push(DeviceReg {process_index, state_size, kind, init_index, parameter_changed_index, field_changed_index, sample_changed_index});
        id
    }

    /// Map a device-box type name to a loaded device (its index). This is the whole device table: given a
    /// device box in the graph, the engine looks up its box name here to find the plugin that realizes it.
    fn set_device_box_type(&mut self, name: String, device_id: usize) {
        self.device_box_types.push((name, device_id));
    }

    /// The plugin that realizes a device-box TYPE. The mapping is by type, not by instance: every box of the
    /// same type uses the same plugin entry (each box still gets its own bridge + state block, i.e. a
    /// separate instance). `None` for a type with no table entry (an unknown / unsupported device).
    fn device_for_type(&self, box_type: &str) -> Option<DeviceReg> {
        let id = self.device_box_types.iter().find(|(name, _)| name == box_type).map(|(_, id)| *id)?;
        self.devices.get(id).copied()
    }

    /// Register a composite box type: a device box that hosts a child collection (its `children_field`) of its
    /// own instruments, each child ordered / routed by `index_key`. Like `set_device_box_type`, this is the
    /// whole composite glue — the host registers it once and the engine learns nothing else about it.
    fn register_composite(&mut self, box_type: String, children_field: u16, index_key: u16, exclude_key: u16) {
        self.composites.push(CompositeSpec {box_type, children_field, index_key, exclude_key});
    }

    /// The composite spec for a box TYPE, if it is a registered composite host (else `None`, a leaf device).
    /// Cloned so a caller can use it while it also holds `&mut self` to build the children.
    pub(crate) fn composite_for_type(&self, box_type: &str) -> Option<CompositeSpec> {
        self.composites.iter().find(|spec| spec.box_type == box_type).cloned()
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
                    flags: BlockFlags::create(true, block.discontinuous, true, false),
                    p0: block.p0,
                    p1: block.p1,
                    s0: block.s0 as u32,
                    s1: block.s1 as u32,
                    bpm: block.bpm
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
        // Master summing bus: every instrument audio unit's channel strip sums into it. It is the static
        // input bus of THE output audio unit, whose channel strip (built by `output_strip`) is the engine's
        // final master and what `render` reads. Both the bus and the output unit are fixed singletons.
        let output_buffer = shared_audio_buffer();
        let master = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer.clone())));
        self.master_id = self.context.register_processor(master.clone());
        self.master = Some(master);
        self.output_bus = Some(self.output_strip(output_buffer)); // master strip output (or the bus, if no output unit)
        self.observe_audio_units();
        self.observe_audio_files();
        0
    }

    /// Observe the `AudioFileBox` lifecycle: request a sample load for every box already present and for each
    /// one created later, and free it when its box is removed. An imported AND a recorded sample both arrive
    /// as an `AudioFileBox` (the audio thread never produces sample data), so this one observer covers both.
    /// The engine only REQUESTS here (off render); the worklet drains the queue and the main thread delivers
    /// the frames into the `SAMPLES` storage.
    fn observe_audio_files(&mut self) {
        for file in self.graph.find_all_by_name("AudioFileBox") {
            unsafe { SAMPLES.get() }.request(file.uuid);
        }
        self.graph.subscribe_all(Box::new(|_graph, update| {
            match update {
                Update::New {uuid, name, ..} if name == "AudioFileBox" => {
                    unsafe { SAMPLES.get() }.request(*uuid);
                }
                Update::Delete {uuid, name, ..} if name == "AudioFileBox" => {
                    unsafe { SAMPLES.get() }.free(*uuid);
                }
                _ => {}
            }
        }));
    }
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
                engine.reconcile_units(); // apply any audio-unit membership change this transaction recorded
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
/// `state_size` the bytes per instance state block, `kind` its `kind` export (instrument / effect), and
/// `init_index` / `parameter_changed_index` its parameter-hook slots (0 when the device exports none).
/// Returns the device id. Call once per device, before `bind` (which builds the graph and wires devices).
#[no_mangle]
pub extern "C" fn device_register(process_index: u32, state_size: u32, kind: u32, init_index: u32, parameter_changed_index: u32, field_changed_index: u32, sample_changed_index: u32) -> u32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.device_register(process_index, state_size, kind, init_index, parameter_changed_index, field_changed_index, sample_changed_index),
            None => 0
        }
    }
}

/// Add a device-table entry mapping a box-type name -> a loaded device id. The host writes the UTF-8 box
/// name into the input buffer (first `name_len` bytes) and calls this once per device after registering it.
/// This table is the entire device-to-plugin glue; the engine instantiates a device box by looking its
/// type up here.
#[no_mangle]
pub extern "C" fn device_set_box_type(device_id: u32, name_len: usize) {
    unsafe {
        let engine = match ENGINE.get().as_mut() {
            Some(engine) => engine,
            None => return
        };
        let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), name_len);
        if let Ok(name) = core::str::from_utf8(bytes) {
            engine.set_device_box_type(String::from(name), device_id as usize);
        }
    }
}

/// Register a COMPOSITE box type: a device box that hosts a child collection of its own instruments. The host
/// writes the UTF-8 composite box name into the input buffer (first `name_len` bytes) and passes the child
/// collection's host field key + the child index/routing key. Mirrors `device_set_box_type`; the engine reads
/// no composite specifics beyond this, so a composite box plays with zero engine changes.
#[no_mangle]
pub extern "C" fn composite_register(name_len: usize, children_field: u32, index_key: u32, exclude_key: u32) {
    unsafe {
        let engine = match ENGINE.get().as_mut() {
            Some(engine) => engine,
            None => return
        };
        let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), name_len);
        if let Ok(name) = core::str::from_utf8(bytes) {
            engine.register_composite(String::from(name), children_field as u16, index_key as u16, exclude_key as u16);
        }
    }
}

/// Resolve a sample handle (Route F) for a device DURING render: write a `SampleRef` to `out_ptr` and return
/// 1 if the sample is resident (ready), else 0. Bound into each device's `env` like the other `host_*`
/// imports; reads the `SAMPLES` cell read-only, so it never aliases the `&mut Engine` the render path holds.
#[no_mangle]
pub extern "C" fn host_resolve_sample(handle: u32, out_ptr: u32) -> u32 {
    match unsafe { SAMPLES.get() }.resolve(handle) {
        Some(sample_ref) => {
            unsafe { *(out_ptr as *mut abi::SampleRef) = sample_ref; }
            1
        }
        None => 0
    }
}

/// Pop the next sample awaiting a load (the engine queued it on seeing an `AudioFileBox`): write its 16-byte
/// uuid to `out_ptr` and return its handle, or return -1 when none are pending. The worklet drains these
/// after applying a transaction and dispatches each to the main-thread loader. Off-render.
#[no_mangle]
pub extern "C" fn sample_take_request(out_ptr: u32) -> i32 {
    match unsafe { SAMPLES.get() }.take_pending() {
        Some((handle, uuid)) => {
            unsafe { core::ptr::copy_nonoverlapping(uuid.as_ptr(), out_ptr as *mut u8, 16); }
            handle as i32
        }
        None => -1
    }
}

/// Reserve `byte_len` zeroed bytes for the sample's planar f32 frames and return the pointer the loader
/// writes into. Off-render (the worklet calls it once the loader reports the decoded size).
#[no_mangle]
pub extern "C" fn sample_allocate(handle: u32, byte_len: u32) -> u32 {
    unsafe { SAMPLES.get() }.allocate(handle, byte_len as usize)
}

/// Mark a sample ready once the loader has written its frames: `channel_count` planes of `frame_count` f32
/// each, at `sample_rate`. After this the sample resolves for devices. Off-render.
#[no_mangle]
pub extern "C" fn sample_set_ready(handle: u32, frame_count: u32, channel_count: u32, sample_rate: f32) {
    unsafe { SAMPLES.get() }.set_ready(handle, frame_count, channel_count, sample_rate);
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
    use super::{compare_lifecycle};
    use engine_env::event::Event;

    fn note_on(position: f64) -> Event {
        Event::NoteStart {id: 0, position, duration: 240.0, pitch: 60, cent: 0.0, velocity: 0.8}
    }
    fn note_off(position: f64) -> Event {
        Event::NoteComplete {id: 0, position, pitch: 60}
    }
    fn update(position: f64) -> Event {
        Event::Update {position}
    }
    fn kinds(events: &[Event]) -> Vec<&'static str> {
        events.iter().map(|event| match event {
            Event::NoteComplete {..} => "off",
            Event::Update {..} => "param",
            Event::NoteStart {..} => "on"
        }).collect()
    }

    #[test]
    fn input_events_sort_by_position_then_off_param_on() {
        // Added out of order at the SAME position 0, plus a later note-on at 10.
        let mut events = vec![note_on(0.0), update(0.0), note_off(0.0), note_on(10.0)];
        events.sort_by(compare_lifecycle);
        // at position 0: note-off -> param-update -> note-on; then the position-10 note-on.
        assert_eq!(kinds(&events), vec!["off", "param", "on", "on"]);
    }

    #[test]
    fn earlier_position_always_precedes_regardless_of_kind() {
        let mut events = vec![note_on(5.0), note_off(20.0), update(1.0)];
        events.sort_by(compare_lifecycle);
        assert_eq!(events.iter().map(Event::position).collect::<Vec<_>>(), vec![1.0, 5.0, 20.0]);
    }
}
