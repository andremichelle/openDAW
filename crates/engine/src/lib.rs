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
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell, UnsafeCell};
use bindings::value_collection::ValueCollection;
use crate::tempo_map::{SharedTempoMap, TempoMap};
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::Registry;
use boxgraph::subscription::HubEvent;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::{decode_forward, Update};
use abi::{EventRecord, ParamChange, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::audio_output_buffer_registry::AudioOutputBufferRegistry;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::engine_context::{EngineContext, NodeId};
use engine_env::event::Event;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::ppqn::{first_update_position, pulses_to_samples, UPDATE_CLOCK_RATE};
use engine_env::process_info::ProcessInfo;
use studio_boxes::registry;
use transport::transport::{Marker, Transport, RENDER_QUANTUM};

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
    sample_changed_index: u32,     // slot of the device's `sample_changed` export (observed samples); 0 if none
    soundfont_changed_index: u32,  // slot of the device's `soundfont_changed` export (observed soundfont); 0 if none
    reset_index: u32,              // slot of the device's `reset` export (clears runtime state on STOP); 0 if none
    terminate_index: u32,          // slot of the device's `terminate` export (its INSTANCE is dying — a genuine
                                    // removal, never a chain-edit survivor); releases external resources (e.g.
                                    // a bridge's JS-side instance); 0 if none
    midi_effects_field: u16,       // the device's OWN midi-fx host field key when hosted as a composite child; 0 if none
    audio_effects_field: u16,      // the device's OWN audio-fx host field key when hosted as a composite child; 0 if none
    // SCRIPTABLE devices (Werkstatt / Apparat / Spielwerk): the field keys of the dynamic parameter / sample
    // COLLECTIONS the engine must observe and drive into the device (the params/samples are `WerkstattParameterBox`
    // / `WerkstattSampleBox` children, not fixed paths). 0 = the device has no such collection.
    param_collection_field: u16,
    sample_collection_field: u16
}

/// A registered COMPOSITE box type (e.g. Playfield): a device box that hosts a CHILD COLLECTION of its own
/// instruments rather than a single DSP. The engine learns this as data (registered like a device box type),
/// so it stays mapping-agnostic — no composite box name or field key is hardcoded. `children_field` is the
/// host field whose pointer hub holds the children; `index_key` is the child box field their order / routing
/// reads. Each child is realized generically by its OWN box type (a leaf device, or a nested composite).
/// One stem-export entry (TS `ExportStemConfiguration` minus the fileName): the unit to export and its
/// wiring options. `Default` (all-true chain, no alternates) is what every NON-stem unit uses.
#[derive(Clone, Copy)]
pub(crate) struct StemEntry {
    pub(crate) uuid: [u8; 16],
    pub(crate) include_audio_effects: bool,
    pub(crate) include_sends: bool,
    pub(crate) use_instrument_output: bool,
    pub(crate) skip_channel_strip: bool
}

#[derive(Clone)]
pub(crate) struct CompositeSpec {
    box_type: String,
    pub(crate) children_field: u16,
    pub(crate) index_key: u16,
    pub(crate) exclude_key: u16, // a child's choke-group flag field (0 = the composite has no choke groups)
    // When a composite hosts CELLS (a generic wrapper holding one instrument + its own chains) rather than
    // direct instruments, these are the cell box's fixed field keys: the hosted instrument, and the cell's midi
    // / audio fx-host collections. All zero means the children are direct instruments (e.g. Playfield slots).
    pub(crate) cell_instrument_field: u16,
    pub(crate) cell_midi_field: u16,
    pub(crate) cell_audio_field: u16,
    // A child's `enabled` BooleanField (0 = the composite does not support per-child enable). A disabled child
    // is dropped from the sum (silenced) edge-only, its processors kept. Playfield's slot key is 22, not the
    // base device key 4, so it is declared per composite.
    pub(crate) child_enabled_key: u16,
    // A child's `mute` / `solo` BooleanFields (0 = unsupported). Mirrors TS `SampleProcessor.handleEvent`:
    // a child is SILENT (its note STARTS dropped, releases still pass) when muted, or when any sibling is
    // soloed and it is not. Playfield's slot keys are 40 / 41.
    pub(crate) child_mute_key: u16,
    pub(crate) child_solo_key: u16
}

/// How an effect composite hands its INPUT to its entries. `Broadcast` gives every entry the same signal (the
/// plain parallel stack); `Stereo` splits per channel (entry 0 = left, entry 1 = right). Further splits
/// (frequency, mid/side, tonal) become further variants — the rest of the composite is unchanged.
// WASM CONTRACT: mirrors `EffectCompositeSpec["distributor"]` in core-wasm/src/engine-modules.ts.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Distributor {
    Broadcast = 0,
    Stereo = 1
}

impl Distributor {
    fn from_u32(value: u32) -> Self {
        match value {
            1 => Self::Stereo,
            _ => Self::Broadcast
        }
    }
}

/// An EFFECT composite box type: an audio or midi EFFECT that, instead of being a single leaf DSP, hosts a
/// collection of ENTRIES, each its own effect chain, run in PARALLEL and mixed back together. Registered as
/// data exactly like `CompositeSpec`, so the engine hardcodes no box name or field key.
///
/// Audio (`kind == DEVICE_KIND_AUDIO_EFFECT`): the input is distributed to every entry, each entry's chain
/// output passes its own gain / mute / solo strip into the wet sum, and the composite emits
/// `dry * input + wet * wetSum`. Note (`DEVICE_KIND_MIDI_EFFECT`): the incoming note stream is teed to every
/// entry and their events merged; `gain_key` / `dry_key` / `wet_key` / `input_tap_field` are 0.
#[derive(Clone)]
pub(crate) struct EffectCompositeSpec {
    box_type: String,
    pub(crate) kind: u8,                     // DEVICE_KIND_AUDIO_EFFECT | DEVICE_KIND_MIDI_EFFECT
    pub(crate) distributor: Distributor,
    pub(crate) entries_field: u16,           // the composite's entry collection (host field)
    pub(crate) index_key: u16,               // the entry box's own `index` (UI + sum / merge order)
    pub(crate) chain_field: u16,             // the entry box's fx-host collection (audio or midi, per `kind`)
    pub(crate) label_key: u16,               // the entry box's `label`
    pub(crate) gain_key: u16,                // the entry's gain (dB); 0 for a midi composite (no gain)
    pub(crate) pan_key: u16,                 // the entry's pan (bipolar); 0 = none (its strip stays centred)
    pub(crate) mute_key: u16,                // the entry's mute (automatable; an entry has no `enabled`)
    pub(crate) solo_key: u16,                // the entry's solo (resolved across siblings, like the mixer's)
    pub(crate) dry_key: u16,                 // the composite's dry gain (dB); 0 for a midi composite
    pub(crate) wet_key: u16,                 // the composite's wet gain (dB); 0 for a midi composite
    pub(crate) input_tap_field: u16          // the vertex a nested sidechain taps for the composite's INPUT; 0 = none
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
    unsafe { *PARAM_PUSHES.get() = PARAM_PUSHES.get().wrapping_add(1); }
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
// Native: record the delivery (id, kind, bits, len) for tests when the device declares a `field_changed`
// export (mirroring the wasm "index 0 = none" sentinel), so field-observation tests can assert what reached
// the device without a wasm build.
#[cfg(not(target_family = "wasm"))]
fn call_device_field_changed(field_changed_index: u32, _state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    #[cfg(test)]
    if field_changed_index != 0 {
        unsafe { FIELD_DELIVERIES.get() }.push((id, kind, bits, len));
    }
    #[cfg(not(test))]
    let _ = (field_changed_index, id, kind, bits, len);
}

#[cfg(all(not(target_family = "wasm"), test))]
pub(crate) static FIELD_DELIVERIES: Shared<Vec<(u32, u32, u32, u32)>> = Shared::new(Vec::new());

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

// Call a device's `soundfont_changed(state_ptr, id, handle, present)` export to deliver an observed soundfont
// (the resolved blob handle, or `present == 0` when the pointer is unbound). Called only inside a transaction
// (the pointer observer), never during `process`. Mirrors `call_device_sample_changed`.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_soundfont_changed(soundfont_changed_index: u32, state_ptr: u32, id: u32, handle: u32, present: u32) {
    if soundfont_changed_index == 0 {
        return; // the device exports no `soundfont_changed`; index 0 is the "none" sentinel
    }
    let soundfont_changed: extern "C" fn(u32, u32, u32, u32) = unsafe { core::mem::transmute(soundfont_changed_index as usize) };
    soundfont_changed(state_ptr, id, handle, present);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_soundfont_changed(_soundfont_changed_index: u32, _state_ptr: u32, _id: u32, _handle: u32, _present: u32) {}

// Call a device's `reset(state_ptr)` export to clear its runtime state on a transport STOP. Called outside
// render, never during `process`.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_reset(reset_index: u32, state_ptr: u32) {
    if reset_index == 0 {
        return; // the device exports no `reset`; index 0 is the "none" sentinel
    }
    let reset: extern "C" fn(u32) = unsafe { core::mem::transmute(reset_index as usize) };
    reset(state_ptr);
}
#[cfg(not(target_family = "wasm"))]
fn call_device_reset(_reset_index: u32, _state_ptr: u32) {}

// Call a device's `terminate(state_ptr)` export when its INSTANCE dies (a genuine removal — the box left the
// graph, or the unit/bus/cluster it belonged to was torn down wholesale). NEVER called for a chain-edit
// SURVIVOR (a reorder / rewire keeps its state_ptr and skips this). Releases resources the device holds
// OUTSIDE its state block (e.g. the NAM / script bridge's JS-side instance). Same table-index-is-fn-pointer
// trick as `call_device_reset`.
#[cfg(target_family = "wasm")]
#[inline]
fn call_device_terminate(terminate_index: u32, state_ptr: u32) {
    if terminate_index == 0 {
        return; // the device exports no `terminate`; index 0 is the "none" sentinel
    }
    unsafe { *TERMINATES.get() = TERMINATES.get().wrapping_add(1); }
    let terminate: extern "C" fn(u32) = unsafe { core::mem::transmute(terminate_index as usize) };
    terminate(state_ptr);
}
// Native: count the call (for a device that declares `terminate`) so a removal-vs-reorder test can assert it
// without a wasm build, mirroring `call_device_field_changed`'s native counter.
#[cfg(not(target_family = "wasm"))]
fn call_device_terminate(terminate_index: u32, _state_ptr: u32) {
    if terminate_index != 0 {
        unsafe { *TERMINATES.get() = TERMINATES.get().wrapping_add(1); }
    }
}

const DEVICE_MAX_EVENTS: usize = 256; // per-quantum event scratch the device pulls into
const MAX_BLOCKS_PER_QUANTUM: usize = 16; // a 128-frame quantum rarely splits past a few blocks; pre-reserved so render never reallocs
// The `index` field of an EFFECT device box (DeviceFactory's midi-effect / audio-effect attributes), giving
// the chain order within a host. ONLY effects have it: an instrument box has no `index` (its key 2 is `label`),
// and a composite child (e.g. a PlayfieldSampleBox slot) carries its own index at its own key (the composite's
// `index_key`, not this). So this is used solely for the midi / audio effect chains.
const EFFECT_INDEX_KEY: u16 = 2;

mod metronome;
mod monitor;
mod frozen;
use metronome::Metronome;
mod signature_track;
use signature_track::{SignatureEvent, SignatureTrack};
mod marker_track;
use marker_track::MarkerTrack;
mod plugin_instrument;
mod plugin_audio_effect;
mod plugin_midi_effect;
use plugin_midi_effect::PluginMidiEffect; // named in the PullLink::MidiFx variant defined here
mod audio_unit;
mod audio_region_player;
mod midi_output;
pub(crate) mod broadcast;
mod time_stretch;
mod tempo_map;
mod script_device;
use audio_unit::{AudioUnitBinding, Members};
mod composite;
mod effect_composite;

/// Serialises every test that touches the global `PULL` context. The production engine is single-threaded
/// (only the audio thread runs engine code), so `PULL` is a plain `Shared` cell — but the test harness runs
/// tests on parallel threads, where concurrent access is a data race (it segfaults). ONE lock for the crate:
/// per-module mutexes would not serialise against each other.
#[cfg(test)]
pub(crate) fn pull_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
mod param_automation;
use param_automation::ParamHandle;
mod sample;
use sample::SampleResource;
mod soundfont;
use soundfont::SoundfontResource;

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

// A debug counter of audio device-processor constructions (`PluginInstrument` + `PluginAudioEffect`). Exported
// so a test can assert that a chain REORDER reuses processors (the count does not move) rather than rebuilding
// them — a rebuilt device resets its DSP (e.g. a delay glides its offset from 0, pitching as if new).
static DEVICE_BUILDS: Shared<u32> = Shared::new(0);

pub(crate) fn note_device_build() {
    unsafe { *DEVICE_BUILDS.get() = DEVICE_BUILDS.get().wrapping_add(1); }
}

#[no_mangle]
pub extern "C" fn device_build_count() -> u32 {
    unsafe { *DEVICE_BUILDS.get() }
}

// A debug counter of device parameter pushes (every `call_device_parameter_changed`). Exported so a test can
// assert a chain REORDER does NOT re-push a survivor's parameters (which would glide e.g. the delay's offset).
static PARAM_PUSHES: Shared<u32> = Shared::new(0);

#[no_mangle]
pub extern "C" fn param_push_count() -> u32 {
    unsafe { *PARAM_PUSHES.get() }
}

// A debug counter of device `terminate` calls (genuine instance death only — a chain-edit SURVIVOR is never
// counted). Exported so a test can assert a removal terminates its device exactly once, and a reorder /
// rewire of survivors terminates none.
static TERMINATES: Shared<u32> = Shared::new(0);

#[no_mangle]
pub extern "C" fn device_terminate_count() -> u32 {
    unsafe { *TERMINATES.get() }
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
// The broadcast-bind recorder (`host_bind_broadcast`): (global slot id, field-key path, float count) per
// record. The engine clears it, calls a device's `init`, then drains it in `bind_device` (creating +
// registering the slots). Its OWN cell (NOT `ENGINE`), safe to append re-entrantly from `init`.
static BROADCAST_BINDS: Shared<Vec<(u32, Vec<u16>, u32, u32)>> = Shared::new(Vec::new());
// The device LIVE-DATA broadcast registry: global slot id -> (write ptr, UI-subscribed). Read re-entrantly
// by `host_broadcast_ptr` / `host_broadcast_active` from a device's `process` (never touches `ENGINE`);
// `bind_device` fills the ptr, teardown zeroes it and returns the id to the free list (no unbounded growth
// across chain edits).
pub(crate) static DEVICE_BROADCASTS: Shared<Vec<(u32, bool)>> = Shared::new(Vec::new());
pub(crate) static DEVICE_BROADCAST_FREE: Shared<Vec<u32>> = Shared::new(Vec::new());
// The sample resource (Route F): decoded frames resident in shared memory, keyed by AudioFileBox uuid. Held
// in its OWN cell (NOT `ENGINE`) so a device's re-entrant `host_resolve_sample` call during render never
// aliases the `&mut Engine` the render path holds. Mutated only off-render (the load handshake + box
// observer), read-only during render, so the single-threaded engine never overlaps a borrow.
static SAMPLES: Shared<SampleResource> = Shared::new(SampleResource::new());
// The project's TUNING REFERENCE in Hz (TS `EngineContext.baseFrequency`): `bind` catches up on + subscribes
// to the synced `RootBox.baseFrequency` and records into this cell only. Its OWN cell (NOT `ENGINE`) so a
// device's re-entrant `host_base_frequency` call during render (the Vaporisateur's note-on) never aliases
// the `&mut Engine` the render path holds. Mirrors `SAMPLES`. 440 before bind / when no RootBox exists.
static BASE_FREQUENCY: Shared<f32> = Shared::new(440.0);
// The sample-observe recorder the `host_observe_sample` export appends to: each device's sample pointer-field
// path (e.g. Nano's `file` at `[15]`). After `init`, the engine REACTIVELY tracks each pointer (catch-up +
// subscribe), resolving its target to the AudioFileBox, requesting its frames, and delivering the handle (or
// "unbound") to the device via `sample_changed`. Its OWN cell (NOT `ENGINE`) so the re-entrant
// `host_observe_sample` call from `init` never aliases `&mut Engine`.
static SAMPLE_OBS: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());

// The soundfont resource: the simplified soundfont blobs resident in shared memory, keyed by SoundfontFileBox
// uuid. Its OWN cell (NOT `ENGINE`) so a device's re-entrant `host_resolve_soundfont` call during render never
// aliases the `&mut Engine` the render path holds. Mirrors `SAMPLES`.
static SOUNDFONTS: Shared<SoundfontResource> = Shared::new(SoundfontResource::new());
// The soundfont-observe recorder the `host_observe_soundfont` export appends to: each device's soundfont
// pointer-field path (the Soundfont device's `file` at `[10]`). After `init` the engine reactively tracks the
// pointer, resolving its target `SoundfontFileBox`, requesting its blob, and delivering the handle (or
// "unbound") via `soundfont_changed`. Its OWN cell (NOT `ENGINE`). Mirrors `SAMPLE_OBS`.
static SOUNDFONT_OBS: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());

// One recorded field observation: `path` is the device-box field-key path; `target_key` is 0 for a PLAIN
// field (observed directly via `host_observe_field`) or, for `host_observe_target_string`, the string field
// key read off the POINTER TARGET the path names (schema keys start at 1, so 0 is free as the "plain" tag).
// Both kinds share the `field_changed` id space (the index into `FIELD_OBS`).
pub(crate) struct FieldObs {
    pub(crate) path: Vec<u16>,
    pub(crate) target_key: u16
}

// The field-observe recorder the `host_observe_field` / `host_observe_target_string` exports append to: each
// device's PLAIN box-field path (e.g. a Playfield slot's `index` at `[15]`), or a pointer path whose TARGET's
// string field the device tracks (the NeuralAmp's model JSON). After `init`, the engine `catchup_and_subscribe`s
// each and delivers values through the device's `field_changed` export. Its own cell (NOT `ENGINE`) so the
// re-entrant `host_observe_field` call from `init` never aliases `&mut Engine`.
static FIELD_OBS: Shared<Vec<FieldObs>> = Shared::new(Vec::new());

// The sidechain-bind recorder the `host_bind_sidechain` export appends to: each audio effect's sidechain
// pointer FIELD-KEY path (e.g. the Gate's `side-chain` at `[30]`), in declaration order. After `init` the
// engine resolves each to a source's output and feeds it in as an input PORT (id 2, 3, ...). Its own cell (NOT
// `ENGINE`) so the re-entrant `host_bind_sidechain` call from `init` never aliases `&mut Engine`.
static SIDECHAIN_BIND: Shared<Vec<Vec<u16>>> = Shared::new(Vec::new());

// The CURRENT effect's audio input PORTS (id, left_ptr, right_ptr), swapped in by `PluginAudioEffect::process`
// for the device call so `host_resolve_input` resolves a port to its buffer: id `1` is the through-signal, ids
// `2, 3, ...` the resolved sidechains. Its own cell (NOT `ENGINE`); read-only during render, never aliases the
// graph, exactly like `host_resolve_sample` reading `SAMPLES`.
static INPUTS: Shared<Vec<(u32, u32, u32)>> = Shared::new(Vec::new());

// The box uuid of the device whose `init` is currently running, so a SCRIPTABLE device's `init` can read its
// own uuid via `host_self_uuid` (the engine knows it at bind; the device does not, since it only uses relative
// field paths). The engine sets it right before `call_device_init`. Its own cell, set + read outside render.
static CURRENT_DEVICE_UUID: Shared<[u8; 16]> = Shared::new([0; 16]);
// Regions the note sequencers must SKIP (TS `EngineCommands.ignoreNoteRegion` + `#ignoredRegions`): the
// region currently being RECORDED INTO must not play back (it would re-trigger the notes being captured).
// Cleared on stop / stopRecording. Read from the region iteration (its own cell, never `ENGINE`).
pub(crate) static IGNORED_REGIONS: Shared<Vec<[u8; 16]>> = Shared::new(Vec::new());
// EFFECTS-monitoring staging (its own cells, read re-entrantly by MonitorMix nodes during render): the
// worklet writes the live input channels into MONITOR_INPUT before each render and reads each mapped
// unit's strip output back from MONITOR_OUTPUT after it (forwarded on the worklet's second output).
pub(crate) static MONITOR_INPUT: Shared<[f32; monitor::MONITOR_CHANNELS * RENDER_QUANTUM]> =
    Shared::new([0.0; monitor::MONITOR_CHANNELS * RENDER_QUANTUM]);
pub(crate) static MONITOR_OUTPUT: Shared<[f32; monitor::MONITOR_CHANNELS * RENDER_QUANTUM]> =
    Shared::new([0.0; monitor::MONITOR_CHANNELS * RENDER_QUANTUM]);

// The note-bits slot of the unit CURRENTLY reconciling (its instruments capture it at construction —
// composite slots share their unit's slot). Set around `reconcile_one`'s chain work, cleared after.
#[cfg(not(test))]
static CURRENT_UNIT_NOTE_BITS: Shared<Option<engine_env::telemetry::BroadcastSlot>> = Shared::new(None);
#[cfg(test)]
std::thread_local! {
    // Tests run on parallel threads; the production engine is single-threaded, so the Shared cell is only
    // sound there. Per-thread isolation keeps the tests deterministic (the PARAMS_SIGNAL pattern): the
    // slot holds an Rc, and racing its non-atomic refcount across test threads corrupts it.
    static CURRENT_UNIT_NOTE_BITS: core::cell::RefCell<Option<engine_env::telemetry::BroadcastSlot>> =
        const { core::cell::RefCell::new(None) };
}

pub(crate) fn current_unit_note_bits() -> Option<engine_env::telemetry::BroadcastSlot> {
    #[cfg(not(test))]
    { unsafe { CURRENT_UNIT_NOTE_BITS.get() }.clone() }
    #[cfg(test)]
    { CURRENT_UNIT_NOTE_BITS.with(|cell| cell.borrow().clone()) }
}

pub(crate) fn set_current_unit_note_bits(slot: Option<engine_env::telemetry::BroadcastSlot>) {
    #[cfg(not(test))]
    unsafe { *CURRENT_UNIT_NOTE_BITS.get() = slot; }
    #[cfg(test)]
    CURRENT_UNIT_NOTE_BITS.with(|cell| *cell.borrow_mut() = slot);
}

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
    // `gate` is the child's SILENT flag (mute / not-soloed, TS `SampleProcessor.handleEvent`): while set, the
    // child's note STARTS are dropped (releases + chokes still pass, so held voices stop like TS).
    SlotRoute { upstream: SharedNoteEventSource, choke: Rc<[i32]>, gate: Rc<Cell<bool>> },
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
    clock_armed: bool,
    // The CURRENT CONSUMER's unit note-bits slot (TS `NoteEventInstrument`'s 128-bit `NoteBroadcaster`):
    // resolved note starts/completes set/clear pitch bits. Set by `PluginInstrument` around its device call;
    // cleared during a MidiFx descent so nested pulls mark only their own producers.
    note_bits: Option<engine_env::telemetry::BroadcastSlot>
}

impl PullContext {
    const fn new() -> Self {
        Self {
            current: None, blocks: core::ptr::null(), block_count: 0, sample_rate: 0.0, scratch: Vec::new(),
            params: Vec::new(), clock_armed: false, note_bits: None
        }
    }
}

// Order the device's input event stream: by position, at an EQUAL position by kind priority
// note-off -> param-update -> note-on (so a note ending there releases first, the automated parameter
// is then updated, and a note starting there sees the new value), and at an equal kind by note id
// (emission order, since ids ascend). Extends TS `NoteLifecycleEvent.Comparator` (which only ranks
// note-off before note-on) with the clock update events the pulled stream also carries. The id tiebreak
// makes this a TOTAL order, so the callers can use the non-allocating `sort_unstable_by` (the stable
// sort heap-allocates a scratch buffer past ~25 elements, inside render).
fn compare_lifecycle(a: &Event, b: &Event) -> core::cmp::Ordering {
    match a.position().partial_cmp(&b.position()) {
        Some(core::cmp::Ordering::Equal) | None => lifecycle_rank(a).cmp(&lifecycle_rank(b))
            .then_with(|| lifecycle_id(a).cmp(&lifecycle_id(b))),
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

fn lifecycle_id(event: &Event) -> u64 {
    match event {
        Event::NoteStart {id, ..} | Event::NoteComplete {id, ..} => *id,
        Event::Update {..} => 0
    }
}

/// Host import the device calls (wasm-to-wasm via the loader binding) to PULL its own input events for the
/// pulse range `[from, to)`. It resolves the CURRENT pull link: a leaf sequencer resolves + converts to
/// sample-offset `EventRecord`s directly; a MIDI-fx link descends (routing the fx device's own upstream
/// pull to the next link) and invokes that device's `process_events`. Reads only `PULL`, never `ENGINE`,
/// so it is safe to call re-entrantly from inside `render`.
#[no_mangle]
pub extern "C" fn host_pull_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    pull_events_into(from, to, flags, out, out_ptr)
}

/// The slice-based body of `host_pull_events`, shared with ENGINE-SIDE consumers (the MidiOut node) whose
/// scratch lives behind a real slice — going through the raw `as u32` address would truncate the pointer on
/// a native (test) build. `out_ptr` is the wasm address of `out`, forwarded only to a MIDI-fx device call
/// (wasm-to-wasm; a native build's device stub never dereferences it).
pub(crate) fn pull_events_into(from: f64, to: f64, flags: u32, out: &mut [EventRecord], out_ptr: u32) -> u32 {
    let max = out.len() as u32;
    let link = { unsafe { PULL.get() }.current.clone() };
    // The CONSUMER's note-bits slot, taken before any descent below swaps it out.
    let consumer_bits = { unsafe { PULL.get() }.note_bits.clone() };
    let count = match link {
        Some(PullLink::Source(ref source)) => pull_from_source(source, from, to, flags, out),
        Some(PullLink::SlotRoute {ref upstream, ref choke, ref gate}) => pull_from_slot_route(upstream, choke, gate, from, to, flags, out),
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
                pull.note_bits = None; // nested pulls mark only their own producers (each fx marks itself)
                saved
            };
            let count = effect.process_events(from, to, flags, out_ptr, max);
            effect.mark_notes(&out[..count as usize]);
            {
                let pull = unsafe { PULL.get() };
                effect.swap_params(&mut pull.params);
                pull.clock_armed = saved_armed;
                pull.current = Some(PullLink::MidiFx {effect, upstream});
                pull.note_bits = consumer_bits.clone();
            }
            count
        }
        None => 0
    };
    if count > 0 {
        if let Some(slot) = consumer_bits {
            // Mark the UNIT's held notes (TS `NoteEventInstrument.#showEvent` per resolved lifecycle event).
            for record in &out[..count as usize] {
                if record.kind == EVENT_NOTE_ON {
                    engine_env::telemetry::set_note_bit(&slot, record.pitch as i32, true);
                } else if record.kind == EVENT_NOTE_OFF {
                    engine_env::telemetry::set_note_bit(&slot, record.pitch as i32, false);
                }
            }
        }
    }
    count
}

/// True when the CURRENT quantum's blocks are TRANSPORTING. The update clock only ticks while the transport
/// runs (TS `UpdateClock.process` skips a block without `BlockFlag.transporting`), so a PAUSED quantum (the
/// free-running block, whose pulse range keeps advancing at a position that is NOT the song position) yields
/// no update positions: automated parameters HOLD their last resolved value and the UI broadcasts stay still.
/// A quantum is uniformly playing or paused, so the per-block TS gate collapses to this per-quantum check.
fn quantum_transporting() -> bool {
    let pull = unsafe { PULL.get() };
    if pull.blocks.is_null() {
        return false;
    }
    let blocks = unsafe { core::slice::from_raw_parts(pull.blocks, pull.block_count) };
    blocks.iter().all(|block| block.flags.transporting())
}

/// Host import a render template calls to SEED its fragment loop: the first update position at or AFTER `at`
/// (INCLUSIVE), so a grid point exactly on a block's start fires (mirrors TS `Fragmentor`'s `ceil`). Returns
/// `f64::INFINITY` when the CURRENT device has no automated parameter, or while the transport is NOT running
/// (TS `UpdateClock` emits no update events on a non-transporting block). Reads only `PULL`.
#[no_mangle]
pub extern "C" fn host_first_update_position(at: f64) -> f64 {
    let pull = unsafe { PULL.get() };
    if !pull.clock_armed || !quantum_transporting() {
        return f64::INFINITY;
    }
    first_update_position(at)
}

/// Host import a render template calls to ADVANCE its fragment loop: the next update position STRICTLY after
/// `after` — the engine's update-clock policy (a fixed grid today; the one place to make it tempo-aware).
/// Strict so the loop always moves forward. Returns `f64::INFINITY` when the CURRENT device has no automated
/// parameter (so its render simply does not fragment) or while the transport is NOT running (the TS
/// `UpdateClock` gate). Reads only `PULL` (the current device's clock-armed state, set by its node / the fx
/// descent).
#[no_mangle]
pub extern "C" fn host_next_update_position(after: f64) -> f64 {
    let pull = unsafe { PULL.get() };
    if !pull.clock_armed || !quantum_transporting() {
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
/// Host import a device calls from its `init` to register a LIVE-DATA broadcast slot (`len` floats at the
/// device address + PATH — the TS `broadcaster.broadcastFloats(adapter.address.append(...))` mirror). It only
/// RECORDS the request (into `BROADCAST_BINDS`) and returns the GLOBAL slot id; `bind_device` creates and
/// registers the slot after `init` returns. The device fetches the write ptr via `host_broadcast_ptr`.
/// Touches only its own cells, so it is safe to call re-entrantly from `init`.
#[no_mangle]
pub extern "C" fn host_bind_broadcast(path_ptr: u32, path_len: u32, len: u32, package_type: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let registry = unsafe { DEVICE_BROADCASTS.get() };
    let id = match unsafe { DEVICE_BROADCAST_FREE.get() }.pop() {
        Some(id) => { registry[id as usize] = (0, false); id }
        None => { registry.push((0, false)); (registry.len() - 1) as u32 }
    };
    unsafe { BROADCAST_BINDS.get() }.push((id, path.to_vec(), len.max(1), package_type));
    id
}

/// The write pointer of a device broadcast slot (0 while unbound). Reads only the registry cell, so a device
/// may call it lazily from `process`.
#[no_mangle]
pub extern "C" fn host_broadcast_ptr(id: u32) -> u32 {
    unsafe { DEVICE_BROADCASTS.get() }.get(id as usize).map_or(0, |entry| entry.0)
}

/// Whether the UI currently subscribes to a device broadcast slot (round-tripped by the worklet through
/// `broadcast_set_active`). Producers may skip cold work (the spectrum FFT) while inactive.
#[no_mangle]
pub extern "C" fn host_broadcast_active(id: u32) -> u32 {
    unsafe { DEVICE_BROADCASTS.get() }.get(id as usize).map_or(0, |entry| entry.1 as u32)
}

#[no_mangle]
pub extern "C" fn host_observe_sample(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let obs = unsafe { SAMPLE_OBS.get() };
    obs.push(path.to_vec());
    obs.len() as u32 - 1
}

/// Host import a device calls from its `init` to OBSERVE its SOUNDFONT reference by the box pointer-field PATH
/// (`[10]` for the Soundfont device's `file`). Only RECORDS the path (into `SOUNDFONT_OBS`) and returns its id;
/// after `init` the engine reactively tracks the pointer, resolving + requesting the soundfont and delivering
/// the handle via `soundfont_changed`. Touches no `&mut Engine`, so it is safe from `init`. Mirrors
/// `host_observe_sample`.
#[no_mangle]
pub extern "C" fn host_observe_soundfont(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let obs = unsafe { SOUNDFONT_OBS.get() };
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
    obs.push(FieldObs {path: path.to_vec(), target_key: 0});
    obs.len() as u32 - 1
}

/// Host import a device calls from its `init` to observe a POINTER field by its field-key PATH, tracking the
/// TARGET box's STRING field `field_key`: on catch-up and every set / repoint / clear the engine resolves the
/// target and delivers its string through `field_changed` (`FIELD_KIND_STRING`, empty = unbound). Shares the
/// `FIELD_OBS` id space with `host_observe_field`. Touches no `&mut Engine`, so it is safe from `init`.
#[no_mangle]
pub extern "C" fn host_observe_target_string(path_ptr: u32, path_len: u32, field_key: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let obs = unsafe { FIELD_OBS.get() };
    obs.push(FieldObs {path: path.to_vec(), target_key: field_key as u16});
    obs.len() as u32 - 1
}

/// Host import a SCRIPTABLE device calls from `init` to learn its own box uuid (16 bytes written to `out16_ptr`),
/// which it passes to the JS script bridge so the bridge finds the matching user `Processor`. Reads only the
/// `CURRENT_DEVICE_UUID` cell the engine set before `init`, never `&mut Engine`.
#[no_mangle]
pub extern "C" fn host_self_uuid(out16_ptr: u32) {
    let uuid = unsafe { *CURRENT_DEVICE_UUID.get() };
    unsafe { core::ptr::copy_nonoverlapping(uuid.as_ptr(), out16_ptr as *mut u8, 16); }
}

/// Host import an audio effect calls from `init` to declare a SIDECHAIN input port by its pointer field-key
/// path. Records the path (the engine resolves it after `init`) and returns the device-facing PORT id: `2` for
/// the first sidechain, `3` for the next, and so on, after the reserved `MAIN_INPUT` (1). Touches no
/// `&mut Engine`, so it is safe from `init`.
#[no_mangle]
pub extern "C" fn host_bind_sidechain(path_ptr: u32, path_len: u32) -> u32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr as *const u16, path_len as usize) };
    let bind = unsafe { SIDECHAIN_BIND.get() };
    bind.push(path.to_vec());
    (bind.len() - 1) as u32 + 2
}

/// Host import an effect calls DURING render to resolve an audio input PORT by id: write an `AudioInputRef` to
/// `out_ptr` and return 1 if the port is wired, else 0. `INPUTS` holds the current effect's ports (swapped in
/// by `PluginAudioEffect::process`): id 1 the through-signal, ids 2+ its resolved sidechains. Reads `INPUTS`
/// read-only, so it never aliases the `&mut Engine` the render path holds, exactly like `host_resolve_sample`.
#[no_mangle]
pub extern "C" fn host_resolve_input(id: u32, out_ptr: u32) -> u32 {
    let ports = unsafe { INPUTS.get() };
    for &(port_id, left, right) in ports.iter() {
        if port_id == id {
            unsafe { *(out_ptr as *mut abi::AudioInputRef) = abi::AudioInputRef {left, right, frames: RENDER_QUANTUM as u32}; }
            return 1;
        }
    }
    0
}

/// Host import a device calls for the project's tuning reference in Hz (TS `EngineContext.baseFrequency`,
/// `RootBox.baseFrequency`): the Vaporisateur reads it per note-on, mirroring TS `computeFrequency`. Reads
/// only the `BASE_FREQUENCY` cell, so it is safe re-entrantly during render, exactly like
/// `host_resolve_sample` reading `SAMPLES`.
#[no_mangle]
pub extern "C" fn host_base_frequency() -> f32 {
    unsafe { *BASE_FREQUENCY.get() }
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

// The update-clock grid (`UPDATE_CLOCK_RATE`) and its `first_update_position` live in `dsp::ppqn` (the
// WASM-CONTRACT home), shared with the channel strip's automated-gain fragmentation.

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
fn pull_from_source(source: &SharedNoteEventSource, from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> u32 {
    let pull = unsafe { PULL.get() };
    pull.scratch.clear();
    source.borrow_mut().process_notes(from, to, BlockFlags(flags), &mut |event| pull.scratch.push(event));
    pull.scratch.sort_unstable_by(compare_lifecycle);
    let mut count = 0;
    for event in &pull.scratch {
        if count >= out.len() {
            break;
        }
        let record = match *event {
            Event::NoteStart {id, position, duration, pitch, cent, velocity} => EventRecord {
                position,
                offset: 0,
                kind: EVENT_NOTE_ON,
                id: id as u32,
                pitch: pitch as u32,
                velocity,
                cent,
                duration // the note's length in pulses, carried on the note-on so a MIDI-fx script sees it
            },
            Event::NoteComplete {id, position, pitch} => EventRecord {
                position,
                offset: 0,
                kind: EVENT_NOTE_OFF,
                id: id as u32,
                pitch: pitch as u32,
                velocity: 0.0,
                cent: 0.0,
                duration: 0.0
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
fn pull_from_slot_route(upstream: &SharedNoteEventSource, choke: &[i32], gate: &Cell<bool>, from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> u32 {
    let pull = unsafe { PULL.get() };
    pull.scratch.clear();
    upstream.borrow_mut().process_notes(from, to, BlockFlags(flags), &mut |event| pull.scratch.push(event));
    pull.scratch.sort_unstable_by(compare_lifecycle);
    let mut count = 0;
    for event in &pull.scratch {
        if count >= out.len() {
            break;
        }
        match *event {
            Event::NoteStart {id, position, pitch, cent, velocity, ..} => {
                if choke.contains(&(pitch as i32)) {
                    out[count] = EventRecord {position, offset: 0, kind: EVENT_CHOKE, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
                    count += 1;
                    if count >= out.len() {
                        break;
                    }
                }
                if gate.get() {
                    continue; // silent (muted / not soloed): the start never reaches the device (TS mirror)
                }
                out[count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id: id as u32, pitch: pitch as u32, velocity, cent, duration: 0.0};
            }
            Event::NoteComplete {id, position, pitch} => {
                out[count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: id as u32, pitch: pitch as u32, velocity: 0.0, cent: 0.0, duration: 0.0};
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
    // RECORDING state (TS `TimeInfo.isRecording/isCountingIn` + `EngineProcessor.#prepareRecordingState`):
    // during a count-in the transport runs from `recording_start - offset` with the metronome FORCED on;
    // reaching `recording_start` flips to recording and restores the metronome preference.
    is_recording: bool,
    is_counting_in: bool,
    recording_start: f64,
    recording_denominator: i32, // the signature denominator at the recording start (the count-in remaining unit)
    metronome_pref: bool,
    // Recording/loop preferences (TS settings.recording.allowTakes / settings.playback.pauseOnLoopDisabled).
    allow_takes: bool,
    pause_on_loop_disabled: bool,
    click_pending: Vec<f32>, // the buffer the worklet fills between `click_allocate` and `set_click_sound`
    // The EFFECTS-monitoring map (TS `#monitoringMap`): units whose chains inject the staged live input
    // and whose strip outputs are copied back for the worklet's monitor return.
    monitoring_map: Vec<monitor::MonitorEntry>,
    // STEM-EXPORT configuration (TS `exportConfiguration.stems` -> per-unit `AudioUnitOptions`): set ONCE
    // before `bind` by the offline worker; each entry's unit renders with its options and its TAP is copied
    // into `stem_staging` after every render (stem i -> planar channels 2i / 2i+1).
    stem_exports: Vec<StemEntry>,
    stem_staging: Vec<f32>,
    // The metronome renders HERE rather than straight into `output`, so its signal can be routed twice: it is
    // always mixed into `output` (the live engine's and the mixdown's behaviour, unchanged), and when
    // `metronome_stem` is set it is ALSO copied into the stem staging as the LAST pair
    // (TS `exportConfiguration.metronome.stem`). A fixed array: no allocation on the render path.
    metronome_staging: [f32; RENDER_QUANTUM * 2],
    // Append the metronome as an additional stem, after every unit stem. Set together with `stem_exports`,
    // which sizes `stem_staging` to include this extra pair.
    metronome_stem: bool,
    // FROZEN units (TS `setFrozenAudio`): pre-rendered PCM per unit — the chain wiring swaps the
    // instrument + fx for a `FrozenPlayback` while an entry exists. `frozen_pending` holds the buffer the
    // worklet fills between `frozen_allocate` and `set_frozen_audio`.
    frozen_audio: Vec<([u8; 16], Rc<frozen::FrozenData>)>,
    frozen_pending: Vec<f32>,
    tempo: Option<ValueCollection>,
    // The SIGNATURE TRACK (TS `SignatureTrackAdapter`): the accumulated time-signature events the
    // metronome walks per block and the count-in resolves the recording-start signature from.
    signature: Option<SignatureTrack>,
    // The MARKER TRACK (TS `MarkerTrackAdapter`): the position-sorted markers the transport's block
    // loop follows (a section repeats `plays` times before falling through).
    marker_track: Option<MarkerTrack>,
    // Queued marker-state notifications for `marker_changes_take` (uuid + plays-so-far, or the null
    // state), feeding the switchMarkerState back-channel (the clip-changes pattern).
    marker_changes: Vec<(Uuid, i32, bool)>,
    tempo_map: SharedTempoMap, // ppqn -> real-seconds map (tempo-automation aware), read by the audio-region player

    context: EngineContext,
    output_bus: Option<SharedAudioBuffer>,
    master: Option<Rc<RefCell<AudioBusProcessor>>>, // the output bus, retained so units wire into it live
    master_id: NodeId,
    audio_units: Vec<AudioUnitBinding>, // one per connected AudioUnitBox, maintained reactively
    // The clip-launch state machine (TS ClipSequencingAudioContext), shared with every unit's note
    // sequencer(s); its change queue feeds the notifyClipSequenceChanges back-channel.
    clip_sequencer: Rc<RefCell<engine_env::clip_sequencer::ClipSequencer>>,
    // The `playback.truncateNotesAtRegionEnd` preference (TS reads it live per block), shared with
    // every note sequencer via `bind_truncate_preference`.
    pub(crate) truncate_pref: Rc<Cell<bool>>,
    // Armed by a unit's SOLO field edit (and by any reconcile that changed routing): the next
    // reconcile pass re-resolves solo into per-strip forced_silent flags (TS Mixer.updateSolo).
    solo_dirty: Rc<Cell<bool>>,
    unit_changes: Rc<RefCell<Members>>, // recorded by the audio-units membership observer, drained by reconcile
    dirty_units: Rc<RefCell<Vec<Uuid>>>, // unit uuids a related edit touched; reconcile rewires ONLY these, not all
    // The audio-output registry (Route C): each unit's strip output keyed by its box address, so a sidechain
    // pointer resolves to the buffer to read and the node to depend on. Each unit keeps its own persistent
    // sidechain bindings (see `AudioUnitBinding::sidechains`); the resolve pass re-resolves them per reconcile.
    output_registry: AudioOutputBufferRegistry<NodeId>,
    // The SEND/RETURN bus registry: each non-primary `AudioBusBox`'s summing bus (`AudioBusProcessor`), keyed
    // by the bus box uuid, built when its bus-type audio unit is wired. A unit's `output` (25) or an
    // `AuxSendBox`'s `targetBus` resolves through this to the sum node to feed; the PRIMARY bus is ABSENT (it
    // maps to the fixed `master`, the fallback). See `resolve_outputs` / `resolve_sends` in audio_unit.
    bus_registry: BTreeMap<Uuid, (Rc<RefCell<AudioBusProcessor>>, NodeId)>,
    // The live-telemetry broadcast table (meters / note activity) the worklet mirrors to the UI.
    broadcasts: broadcast::Broadcasts,
    // The MIDI-OUT state (TS MIDIOutputDeviceProcessor + MIDITransportClock): the message queue drained by
    // `midi_out_take`, the device-id table, the scheduled transport messages, and the registered
    // `MIDIOutputBox` targets (see `sync_midi_targets`). Shared with the per-unit MidiOut nodes.
    midi_out: midi_output::SharedMidiOut,
    sample_rate: f32,
    blocks: Vec<Block>,
    devices: Vec<DeviceReg>,           // loaded device plugins, in load order (the host registers them)
    device_box_types: Vec<(String, usize)>, // box-type name -> index into `devices`: the ONLY device glue.
    composites: Vec<CompositeSpec>,    // registered composite box types (host of a child collection); data, not code
    effect_composites: Vec<EffectCompositeSpec>, // registered EFFECT composite box types (parallel fx entries)
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
            is_recording: false,
            is_counting_in: false,
            recording_start: 0.0,
            recording_denominator: 4,
            metronome_pref: false,
            allow_takes: true,
            pause_on_loop_disabled: false,
            click_pending: Vec::new(),
            monitoring_map: Vec::new(),
            stem_exports: Vec::new(),
            stem_staging: Vec::new(),
            metronome_staging: [0.0; RENDER_QUANTUM * 2],
            metronome_stem: false,
            frozen_audio: Vec::new(),
            frozen_pending: Vec::new(),
            tempo: None,
            signature: None,
            marker_track: None,
            marker_changes: Vec::with_capacity(16), // drained every quantum; pre-reserved so render never reallocs
            tempo_map: Rc::new(RefCell::new(TempoMap::new())),
            context: EngineContext::new(),
            output_bus: None,
            master: None,
            master_id: 0,
            audio_units: Vec::new(),
            clip_sequencer: Rc::new(RefCell::new(engine_env::clip_sequencer::ClipSequencer::new())),
            truncate_pref: Rc::new(Cell::new(false)),
            solo_dirty: Rc::new(Cell::new(false)),
            unit_changes: Rc::new(RefCell::new(Members::default())),
            dirty_units: Rc::new(RefCell::new(Vec::new())),
            output_registry: AudioOutputBufferRegistry::new(),
            bus_registry: BTreeMap::new(),
            broadcasts: broadcast::Broadcasts::default(),
            midi_out: midi_output::shared_midi_out(),
            sample_rate,
            blocks: Vec::with_capacity(MAX_BLOCKS_PER_QUANTUM), // a quantum splits into a few blocks (tempo / loop); never realloc on the render path
            devices: Vec::new(),
            device_box_types: Vec::new(),
            composites: Vec::new(),
            effect_composites: Vec::new(),
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
    fn device_register(&mut self, process_index: u32, state_size: u32, kind: u32, init_index: u32, parameter_changed_index: u32, field_changed_index: u32, sample_changed_index: u32, soundfont_changed_index: u32, reset_index: u32, terminate_index: u32, midi_effects_field: u32, audio_effects_field: u32, param_collection_field: u32, sample_collection_field: u32) -> u32 {
        let id = self.devices.len() as u32;
        self.devices.push(DeviceReg {process_index, state_size, kind, init_index, parameter_changed_index, field_changed_index, sample_changed_index, soundfont_changed_index, reset_index, terminate_index,
            midi_effects_field: midi_effects_field as u16, audio_effects_field: audio_effects_field as u16,
            param_collection_field: param_collection_field as u16, sample_collection_field: sample_collection_field as u16});
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
    #[allow(clippy::too_many_arguments)] // one positional field key per composite facet, matching the loader
    fn register_composite(&mut self, box_type: String, children_field: u16, index_key: u16, exclude_key: u16,
                          cell_instrument_field: u16, cell_midi_field: u16, cell_audio_field: u16, child_enabled_key: u16,
                          child_mute_key: u16, child_solo_key: u16) {
        self.composites.push(CompositeSpec {box_type, children_field, index_key, exclude_key,
            cell_instrument_field, cell_midi_field, cell_audio_field, child_enabled_key, child_mute_key, child_solo_key});
    }

    /// The composite spec for a box TYPE, if it is a registered composite host (else `None`, a leaf device).
    /// Cloned so a caller can use it while it also holds `&mut self` to build the children.
    pub(crate) fn composite_for_type(&self, box_type: &str) -> Option<CompositeSpec> {
        self.composites.iter().find(|spec| spec.box_type == box_type).cloned()
    }

    /// Register an EFFECT composite box type (parallel fx / note entries). The sibling of `register_composite`:
    /// the whole glue is this one record, so a new split container is a registration, not engine code.
    #[allow(clippy::too_many_arguments)] // one positional field key per facet, matching the loader
    fn register_effect_composite(&mut self, box_type: String, kind: u8, distributor: Distributor, entries_field: u16,
                                 index_key: u16, chain_field: u16, label_key: u16, gain_key: u16, pan_key: u16,
                                 mute_key: u16, solo_key: u16, dry_key: u16, wet_key: u16, input_tap_field: u16) {
        self.effect_composites.push(EffectCompositeSpec {box_type, kind, distributor, entries_field, index_key,
            chain_field, label_key, gain_key, pan_key, mute_key, solo_key, dry_key, wet_key, input_tap_field});
    }

    /// The effect-composite spec for a box TYPE, if it is a registered parallel composite (else `None`, a leaf
    /// effect). Cloned so a caller can use it while it also holds `&mut self` to build the entries.
    pub(crate) fn effect_composite_for_type(&self, box_type: &str) -> Option<EffectCompositeSpec> {
        self.effect_composites.iter().find(|spec| spec.box_type == box_type).cloned()
    }

    /// Apply one forward-only transaction, returning the resulting checksum (or `Err` on a
    /// decode/apply failure). The value/note caches update themselves inside `transaction`.
    fn apply_updates(&mut self, input: &[u8]) -> Result<(), ()> {
        let mut reader = ByteReader::new(input);
        let mut updates = decode_forward(&mut reader).map_err(|_| ())?;
        // The wire delete task carries only the uuid (frozen contract), so `decode_forward` leaves the name
        // empty. Resolve each box's class name from the still-present graph (it is removed inside
        // `transaction`) so lifecycle observers can match it (e.g. the `AudioFileBox` sample free).
        for update in &mut updates {
            if let Update::Delete {uuid, name, ..} = update {
                if name.is_empty() {
                    if let Some(found) = self.graph.find_box(uuid) {
                        *name = found.name.clone();
                    }
                }
            }
        }
        self.graph.transaction(&updates, &self.registry).map_err(|_| ())?;
        Ok(())
    }

    /// The rolling graph checksum, computed on demand (a full-graph field walk, O(all boxes)). Only the
    /// throttled verification path (~1/s) needs it, so it must NOT run per transaction — a marquee selection
    /// fires dozens of transactions per second, and hashing the whole graph each time dropped audio.
    fn checksum(&self) -> [u8; 32] {
        self.graph.checksum()
    }

    /// Render one quantum into `output` (planar L|R) and write the transport state into `state`.
    fn render(&mut self, output: &mut [f32], state: &mut [u8]) {
        for sample in output.iter_mut() {
            *sample = 0.0
        }
        // apply the latest timeline values recorded by the subscriptions
        self.transport.set_bpm(self.controls.bpm.get());
        // TS BlockRenderer:143 loop gate: no wrap during a count-in, none while recording without takes;
        // `pauseOnLoopDisabled` keeps the loop ACTION armed (it pauses at the loop end instead of wrapping).
        let loop_gate = (self.controls.loop_enabled.get() && !self.is_counting_in
            && (!self.is_recording || self.allow_takes)) || self.pause_on_loop_disabled;
        self.transport.set_loop_enabled(loop_gate);
        self.transport.set_loop_pause(self.pause_on_loop_disabled);
        self.transport.set_loop_from(self.controls.loop_from.get());
        self.transport.set_loop_to(self.controls.loop_to.get());
        // refresh the tempo map the audio-region player reads: the live automation curve under the same
        // condition the transport uses it (enabled + non-empty), else a constant tempo at the configured bpm.
        let tempo_curve = if self.controls.tempo_automation_enabled.get() {
            self.tempo.as_ref().filter(|collection| !collection.is_empty()).map(|collection| collection.curve())
        } else {
            None
        };
        self.tempo_map.borrow_mut().update(self.controls.bpm.get(), tempo_curve);
        // The count-in flip (TS `renderer.setCallback(recordingStartTime, ...)`): once the playhead reaches
        // the recording start, counting-in becomes recording and the metronome returns to its preference.
        // Quantum-granular (TS splits the block at the exact position; one quantum ≈ 2.7 ms).
        if self.is_counting_in && self.transport.position() >= self.recording_start {
            self.is_counting_in = false;
            self.is_recording = true;
            self.metronome.set_enabled(self.metronome_pref);
        }
        let recording_start = self.recording_start;
        let denominator = self.recording_denominator;
        let sample_rate = self.sample_rate;
        // Automated SOLO resolves at the ENGINE level (it silences other strips), so it cannot ride a single strip's
        // per-block automation like volume / mute. Resolve it once at this quantum's start position and re-run the
        // solo walk before the graph processes; only while transporting, so a paused block HOLDS the last solo
        // (TS `UpdateClock` gates updates on `transporting`).
        if self.transport.is_playing() {
            self.resolve_automated_solo(self.transport.position());
        }
        let Engine {transport, metronome, metronome_staging, context, output_bus, blocks, tempo, tempo_map: _,
            controls, signature, marker_track, marker_changes, midi_out, is_recording, is_counting_in,
            metronome_pref, ..} = self;
        // `Metronome::process` mixes ADDITIVELY, so its buffer starts cleared every quantum, exactly like
        // `output` above.
        metronome_staging.fill(0.0);
        // The signature events the metronome walks: the live signature track once bound, else a single
        // storage-signature entry from the controls (the pre-bind fallback).
        let signature_events = signature.as_ref().map(|track| track.events());
        let signature_fallback = [SignatureEvent {index: -1, accumulated_ppqn: 0.0, nominator: controls.nominator.get(), denominator: controls.denominator.get()}];
        let signature_slice: &[SignatureEvent] = signature_events.as_deref().map_or(&signature_fallback, |events| events.as_slice());
        // The markers the transport's block loop follows: an edit raises the track's changed flag, the
        // transport re-resolves the active marker at the next block (TS `#someMarkersChanged`).
        if marker_track.as_ref().is_some_and(|track| track.take_changed()) {
            transport.notify_markers_changed();
        }
        let marker_events = marker_track.as_ref().map(|track| track.markers());
        let marker_slice: &[Marker] = marker_events.as_deref().map_or(&[], |events| events.as_slice());
        let markers_enabled = marker_track.as_ref().is_some_and(|track| track.enabled());
        blocks.clear();
        if transport.is_playing() {
            // use the tempo map only when automation is enabled and non-empty, else the fixed bpm
            let events = if controls.tempo_automation_enabled.get() {
                tempo.as_ref().map(|tempo| tempo.events())
            } else {
                None
            };
            let active = events.as_deref().filter(|collection| !collection.is_empty());
            // collect this quantum's blocks (converting transport flags) and run the metronome per block
            transport.render_quantum(active, marker_slice, markers_enabled, |block| {
                // into the metronome's OWN buffer, not `output`: it is mixed into the output below and may
                // additionally be copied out as its own stem.
                let (left, right) = metronome_staging.split_at_mut(RENDER_QUANTUM);
                metronome.process(block, signature_slice, &mut left[block.s0..block.s1], &mut right[block.s0..block.s1]);
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
            // `pauseOnLoopDisabled` stopped the transport AT the loop end mid-quantum (TS
            // `timeInfo.pause()` + `releaseBlock`): drop the recording flags like `pause()` does and
            // render the quantum's remainder as one free-running NON-playing block, so held notes
            // release and tails ring out instead of hard-cutting.
            if !transport.is_playing() {
                *is_recording = false;
                *is_counting_in = false;
                metronome.set_enabled(*metronome_pref); // apply_metronome with the count-in force gone
                let covered = blocks.last().map_or(0, |block| block.s1 as usize);
                if covered < RENDER_QUANTUM {
                    let paused = transport.render_paused_tail(RENDER_QUANTUM - covered);
                    blocks.push(Block {
                        index: blocks.len() as u32,
                        flags: BlockFlags::create(false, false, false, false),
                        p0: paused.p0,
                        p1: paused.p1,
                        s0: covered as u32,
                        s1: RENDER_QUANTUM as u32,
                        bpm: paused.bpm
                    });
                }
            }
        } else {
            // PAUSED: still process the graph for one free-running quantum (the song `position` is frozen, but
            // the pulse range keeps ADVANCING) so the sequencer flushes its held notes into note-offs (its
            // NON-playing pull triggers `release_all`), active voices go to release, and effect tails ring out,
            // while no new notes are read. This mirrors the not-transporting branch of TS `BlockRenderer`, and
            // avoids the click of an abrupt cut. The metronome stays silent (it only ticks on a moving block).
            let paused = transport.render_paused(marker_slice);
            blocks.push(Block {
                index: 0,
                flags: BlockFlags::create(false, false, false, false),
                p0: paused.p0,
                p1: paused.p1,
                s0: paused.s0 as u32,
                s1: paused.s1 as u32,
                bpm: paused.bpm
            });
        }
        // Queue a switchMarkerState notification when the active marker (or its play count) moved
        // this quantum (TS raises `markerChanged` and notifies once per `process`).
        if transport.take_marker_changed() {
            match transport.current_marker() {
                Some((uuid, count)) => marker_changes.push((uuid, count, true)),
                None => marker_changes.push(([0u8; 16], 0, false))
            }
        }
        // The MIDI transport clock (TS MIDITransportClock): deliver the scheduled Start/Stop/SongPosition
        // messages and emit the 24-ppq Clock ticks over the transporting blocks, gated by the registered
        // MIDIOutputBoxes. Off-graph like the metronome.
        midi_output::process_transport_clock(midi_out, blocks.as_slice(), sample_rate);
        // The metronome into the main mix. Identical to when it wrote into `output` directly (both mixes are
        // additive into a cleared buffer), and it stays unconditional: a stems render never reads `output`
        // (the worker takes the stem staging and returns early), so there is nothing to gate it on.
        for index in 0..RENDER_QUANTUM * 2 {
            output[index] += metronome_staging[index];
        }
        // drive the processor graph over the quantum's blocks (advancing or static), then mix the output bus in
        context.process(&ProcessInfo {blocks: blocks.as_slice()});
        if let Some(buffer) = output_bus.as_ref() {
            let buffer = buffer.borrow();
            for index in 0..RENDER_QUANTUM {
                output[index] += buffer.left[index];
                output[RENDER_QUANTUM + index] += buffer.right[index];
            }
        }
        write_engine_state(transport, state, *is_recording, *is_counting_in, recording_start, denominator);
    }

    fn play(&mut self) {
        // TS `#play` schedules MidiData.Start (the timestamp SongPosition is scheduled by `set_position`,
        // which the worklet's play command issues first when timestamp playback is enabled).
        self.schedule_midi_transport(midi_output::start_message());
        self.transport.play()
    }

    /// Schedule a MIDI transport message for the next quantum (TS `midiTransportClock.schedule`).
    fn schedule_midi_transport(&mut self, message: ([u8; 3], u8)) {
        let (bytes, len) = message;
        self.midi_out.borrow_mut().schedule(bytes, len);
    }

    /// Arm recording (TS `EngineProcessor.#prepareRecordingState`): stopped + count-in wanted -> run the
    /// transport from `recording_start - countInBars` with the metronome forced on (the flip to recording
    /// happens in `render` when the playhead reaches the start); else record immediately from here.
    fn prepare_recording_state(&mut self, count_in: bool, count_in_bars: f64) {
        if self.is_recording || self.is_counting_in {
            return;
        }
        if !self.transport.is_playing() && count_in {
            // The count-in bar length: the signature IN EFFECT at the recording start (via the signature
            // track; the storage signature when the track is empty/disabled). NOTE: TS `#prepareRecordingState`
            // reads the static `timelineBoxAdapter.signature` even with signature events present — this
            // resolves the track instead, identical whenever the track is empty or disabled.
            let position = self.transport.position();
            let (nominator, denominator) = self.signature.as_ref()
                .map_or((self.controls.nominator.get(), self.controls.denominator.get()),
                        |track| track.signature_at(position));
            let offset = dsp::ppqn::from_signature((count_in_bars * nominator as f64) as i32, denominator);
            self.recording_start = position;
            self.recording_denominator = denominator;
            self.is_counting_in = true;
            self.apply_metronome();
            self.transport.seek(self.recording_start - offset);
            self.transport.play();
            // TS `#prepareRecordingState` count-in branch: SongPosition at the count-in start, NO Start.
            self.schedule_midi_transport(midi_output::position_message(self.transport.position()));
        } else {
            self.is_recording = true;
            self.transport.play();
            self.schedule_midi_transport(midi_output::start_message());
        }
    }

    /// End recording (TS `EngineProcessor.#stopRecording`): drop the flags, restore the metronome, and
    /// PAUSE the transport (no reset — the recorded takes stay audible where the playhead stopped).
    fn stop_recording(&mut self) {
        if !self.is_recording && !self.is_counting_in {
            return;
        }
        self.is_recording = false;
        self.is_counting_in = false;
        self.apply_metronome();
        self.transport.stop(false);
        unsafe { IGNORED_REGIONS.get() }.clear();
        self.schedule_midi_transport(midi_output::stop_message()); // TS `#stopRecording` schedules Stop
    }

    /// PAUSE: freeze the transport where it is, keeping all plugin / buffer state, so PLAY resumes seamlessly.
    /// Ends any recording / count-in (TS `TimeInfo.pause` clears both flags).
    fn pause(&mut self) {
        self.is_recording = false;
        self.is_counting_in = false;
        self.apply_metronome();
        unsafe { IGNORED_REGIONS.get() }.clear();
        // TS `#stop` schedules ONE MidiData.Stop per stop command; the worklet's stop command always runs
        // `pause()` (a hard reset calls `stop()` after it, which deliberately schedules nothing more).
        self.schedule_midi_transport(midi_output::stop_message());
        self.transport.stop(false)
    }

    /// STOP: pause, rewind the transport to 0, and reset every plugin (drop voices, clear delay / reverb tails,
    /// filter + detector state) and the bus / strip buffers, so PLAY starts clean. The output bus is zeroed so
    /// no residual leaks into the final mix while stopped.
    fn stop(&mut self) {
        self.is_recording = false;
        self.is_counting_in = false;
        self.apply_metronome();
        unsafe { IGNORED_REGIONS.get() }.clear();
        self.transport.stop(true);
        self.transport.reset_marker_state(); // TS `#reset` -> `renderer.reset()` forgets the active marker (silently)
        self.clip_sequencer.borrow_mut().reset();
        self.context.reset_all();
        for unit in &self.audio_units {
            unit.clear_note_bits(); // TS `NoteEventInstrument.clear` on reset: no stuck note indicators
        }
        if let Some(buffer) = self.output_bus.as_ref() {
            let mut buffer = buffer.borrow_mut();
            buffer.left.fill(0.0);
            buffer.right.fill(0.0);
        }
    }

    /// SEEK: move the playhead (playing or stopped), keeping all plugin / buffer state.
    /// Mirrors the TS engine's `setPosition`.
    fn set_position(&mut self, position: f64) {
        if self.is_recording {
            return; // TS `#setPosition` ignores seeks while recording
        }
        self.transport.seek(position);
        self.schedule_midi_transport(midi_output::position_message(position)) // TS schedules SongPosition
    }

    /// Launch `clip` on its own track (resolved through the clip's `clips` pointer, key 1). Mirrors TS
    /// `EngineCommands.scheduleClipPlay`: the handover happens at the next quantized boundary, and the
    /// TRANSPORT STARTS if it was not running (TS sets `timeInfo.transporting = true`), so launching a
    /// clip from a stopped studio plays immediately.
    pub(crate) fn schedule_clip_play(&mut self, clip: Uuid) {
        if let Some(track) = self.graph.target_of(&Address::of(clip, vec![1])).map(|address| address.uuid) {
            self.clip_sequencer.borrow_mut().schedule_play(track, clip);
            self.play(); // schedules MidiData.Start too (TS `scheduleClipPlay` mirrors `#play` here)
        }
    }

    /// Replace the monitoring map and re-wire every unit that joined or left it (its chain gains / drops
    /// the `MonitorMix` injector). Runs off-render (a worklet command), so the reconcile is immediate.
    fn set_monitoring_map(&mut self, map: Vec<monitor::MonitorEntry>) {
        let mut affected: Vec<[u8; 16]> = Vec::new();
        for entry in self.monitoring_map.iter().chain(map.iter()) {
            if !affected.contains(&entry.uuid) {
                affected.push(entry.uuid);
            }
        }
        self.monitoring_map = map;
        unsafe { MONITOR_OUTPUT.get() }.fill(0.0);
        self.mark_units_rewire(&affected);
        self.reconcile_units();
    }

    /// The frozen PCM of `unit`, if any (TS `AudioUnit.frozen`), consulted by the chain wiring.
    pub(crate) fn frozen_of(&self, unit: &[u8; 16]) -> Option<Rc<frozen::FrozenData>> {
        self.frozen_audio.iter().find(|(uuid, _)| uuid == unit).map(|(_, data)| data.clone())
    }

    /// Attach / replace the frozen PCM of a unit and re-wire it (TS `setFrozenAudio(Option.wrap(data))`).
    fn set_frozen_audio(&mut self, unit: [u8; 16], data: Rc<frozen::FrozenData>) {
        self.frozen_audio.retain(|(uuid, _)| uuid != &unit);
        self.frozen_audio.push((unit, data));
        self.mark_units_rewire(&[unit]);
        self.reconcile_units();
    }

    /// Drop a unit's frozen PCM and re-wire its live chain (TS `setFrozenAudio(Option.None)`).
    fn clear_frozen_audio(&mut self, unit: [u8; 16]) {
        let before = self.frozen_audio.len();
        self.frozen_audio.retain(|(uuid, _)| uuid != &unit);
        if self.frozen_audio.len() != before {
            self.mark_units_rewire(&[unit]);
            self.reconcile_units();
        }
    }

    /// The stem-export options of `unit` (TS `AudioUnitOptions.Default` when it is not a stem), consulted
    /// by the chain wiring and the send/output resolution.
    pub(crate) fn unit_options(&self, unit: &[u8; 16]) -> StemEntry {
        self.stem_exports.iter().find(|entry| &entry.uuid == unit).copied().unwrap_or(StemEntry {
            uuid: *unit, include_audio_effects: true, include_sends: true,
            use_instrument_output: false, skip_channel_strip: false
        })
    }

    /// The staged input channels mapped to `unit` (TS `AudioDeviceChain.setMonitoringChannels`), consulted
    /// by the chain wiring.
    pub(crate) fn monitor_channels_of(&self, unit: &[u8; 16]) -> Option<(i32, i32)> {
        self.monitoring_map.iter().find(|entry| &entry.uuid == unit).map(|entry| (entry.left, entry.right))
    }

    /// Copy each mapped unit's STRIP output (TS `unit.audioOutput()`) into the monitor OUTPUT staging, for
    /// the worklet's second output (the MonitoringRouter return). Runs right after `render`.
    fn copy_monitor_outputs(&mut self) {
        if self.monitoring_map.is_empty() {
            return;
        }
        let staging = unsafe { MONITOR_OUTPUT.get() };
        for entry in &self.monitoring_map {
            let Some(output) = self.output_registry.resolve(&Address::of(entry.uuid, alloc::vec![])) else { continue };
            let buffer = output.buffer.borrow();
            let left = entry.left as usize;
            if entry.left < 0 || left >= monitor::MONITOR_CHANNELS {
                continue;
            }
            staging[left * RENDER_QUANTUM..(left + 1) * RENDER_QUANTUM].copy_from_slice(&buffer.left);
            if (0..monitor::MONITOR_CHANNELS as i32).contains(&entry.right) {
                let right = entry.right as usize;
                staging[right * RENDER_QUANTUM..(right + 1) * RENDER_QUANTUM].copy_from_slice(&buffer.right);
            }
        }
    }

    fn set_metronome_enabled(&mut self, enabled: bool) {
        self.metronome_pref = enabled;
        self.apply_metronome();
    }

    /// The effective metronome: the preference, FORCED on during a count-in (TS sets
    /// `timeInfo.metronomeEnabled = true` for the count-in and restores the preference at the flip).
    fn apply_metronome(&mut self) {
        self.metronome.set_enabled(self.metronome_pref || self.is_counting_in);
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
        // Tuning reference: RootBox.baseFrequency, served to devices via `host_base_frequency` (TS
        // `EngineContext.baseFrequency`). Catch-up delivers the loaded value; live edits retune NEW notes
        // only (the TS voicing strategies call `computeFrequency` at note-on, never mid-voice).
        // WASM CONTRACT: RootBox.baseFrequency = field key 5 (Float32, default 440, boxes RootBox.ts).
        if let Some(root) = self.graph.find_by_name("RootBox") {
            self.graph.catchup_and_subscribe(Address::of(root.uuid, vec![5]), |value| {
                if let Some(value) = value.as_float32() {
                    unsafe { *BASE_FREQUENCY.get() = value; }
                }
            });
        }
        // tempo-automation collection: TimelineBox.tempoTrack (22).events (1) -> ValueEventCollectionBox.owners
        let tempo_collection = self.graph.target_of(&Address::of(uuid, vec![22, 1])).map(|target| target.uuid);
        if let Some(collection) = tempo_collection {
            self.tempo = Some(ValueCollection::observe(&mut self.graph, collection));
        }
        // signature track: TimelineBox.signatureTrack (23) = {events (1, hub), enabled (20)} + the storage
        // signature (10) — the accumulated event list the metronome and the count-in read.
        self.signature = Some(SignatureTrack::observe(&mut self.graph, uuid));
        // marker track: TimelineBox.markerTrack (21) = {markers (1, hub), enabled (20)} — the sorted
        // markers the transport's block loop follows and the switchMarkerState notifications feed from.
        self.marker_track = Some(MarkerTrack::observe(&mut self.graph, uuid));
        // Populate the tempo map BEFORE reconcile reads region spans: a seconds-based audio region's duration /
        // loop-duration are converted tempo-aware at the region position, so the map must reflect the loaded
        // tempo (nominal bpm + automation curve) already at bind, not only from the first render.
        let tempo_curve = if self.controls.tempo_automation_enabled.get() {
            self.tempo.as_ref().filter(|collection| !collection.is_empty()).map(|collection| collection.curve())
        } else {
            None
        };
        self.tempo_map.borrow_mut().update(self.controls.bpm.get(), tempo_curve);
        // Master summing bus: every audio unit's channel strip sums into it (`sum_of(None)`). It is the SUM of
        // THE output audio unit, which reconciles like any bus (`reconcile_bus`): master-sum -> its fx chain ->
        // its strip, whose output it republishes to `output_bus` (what `render` reads) on every rebuild.
        let output_buffer = shared_audio_buffer();
        let master = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer.clone())));
        self.master_id = self.context.register_processor(master.clone());
        self.context.set_label(self.master_id, alloc::string::String::from("master-sum"));
        self.master = Some(master);
        // Fallback until the output unit reconciles (in `observe_audio_units` below): render the raw master sum.
        // The output unit reconciles like any bus (`reconcile_bus`) and republishes `output_bus` to its strip.
        self.output_bus = Some(output_buffer);
        // The MIDI-out targets must register BEFORE the units reconcile (inside `observe_audio_units`): a
        // MIDI-output unit's initial CC push resolves its device through the registry (TS resolves it off
        // the complete graph at construction).
        self.observe_midi_outputs();
        self.observe_audio_units();
        self.observe_audio_files();
        self.observe_soundfont_files();
        0
    }

    /// Track the `MIDIOutputBox`es connected to `RootBox.outputMidiDevices` (TS
    /// `rootBoxAdapter.midiOutputDevices`): the hub observer records joins / leaves into the shared
    /// MIDI-out state and `sync_midi_targets` (run after every transaction) realizes them — creating /
    /// dropping the targeted field subscriptions that keep each target's id / delay / sendTransport live.
    /// WASM CONTRACT: RootBox.outputMidiDevices = field key 35 (boxes RootBox.ts).
    fn observe_midi_outputs(&mut self) {
        const ROOT_OUTPUT_MIDI_DEVICES_KEY: u16 = 35;
        if let Some(root) = self.graph.find_by_name("RootBox") {
            let recorder = self.midi_out.clone();
            self.graph.subscribe_pointer_hub(Address::of(root.uuid, vec![ROOT_OUTPUT_MIDI_DEVICES_KEY]),
                Box::new(move |_graph, event| {
                    match event {
                        HubEvent::Added(source) => recorder.borrow_mut().record_add(source.uuid),
                        HubEvent::Removed(source) => recorder.borrow_mut().record_remove(source.uuid)
                    }
                }));
        }
        self.sync_midi_targets();
    }

    /// Realize the recorded `MIDIOutputBox` joins / leaves: a joiner gets targeted catch-up subscriptions
    /// on its `id` (3), `delayInMs` (5) and `sendTransportMessages` (6) fields feeding its live cells (the
    /// `id` interning assigns the device number the worklet resolves via `midi_out_device_id`); a leaver's
    /// subscriptions are dropped with its registration.
    /// WASM CONTRACT: MIDIOutputBox field keys — id 3 (String), delayInMs 5 (Int32), sendTransportMessages
    /// 6 (Boolean), per boxes MIDIOutputBox.ts.
    fn sync_midi_targets(&mut self) {
        let (added, removed) = self.midi_out.borrow_mut().take_pending();
        for uuid in removed {
            for sub in self.midi_out.borrow_mut().remove_target(&uuid) {
                self.graph.unsubscribe(sub);
            }
        }
        for uuid in added {
            if self.midi_out.borrow().resolve(&uuid).is_some() {
                continue;
            }
            let cells = Rc::new(midi_output::MidiTargetCells {
                device_num: Cell::new(-1), delay_ms: Cell::new(0.0), send_transport: Cell::new(false)
            });
            let mut subs = Vec::new();
            let table = self.midi_out.clone();
            let id_cells = cells.clone();
            subs.push(self.graph.catchup_and_subscribe(Address::of(uuid, vec![3]), move |value| {
                if let Some(id) = value.as_str() {
                    id_cells.device_num.set(table.borrow_mut().intern(id));
                }
            }));
            let delay_cells = cells.clone();
            subs.push(self.graph.catchup_and_subscribe(Address::of(uuid, vec![5]), move |value| {
                if let Some(delay) = value.as_int32() {
                    delay_cells.delay_ms.set(delay as f64);
                }
            }));
            let transport_cells = cells.clone();
            subs.push(self.graph.catchup_and_subscribe(Address::of(uuid, vec![6]), move |value| {
                if let Some(enabled) = value.as_bool() {
                    transport_cells.send_transport.set(enabled);
                }
            }));
            self.midi_out.borrow_mut().add_target(uuid, cells, subs);
        }
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
        self.graph.subscribe_box_lifecycle(Box::new(|_graph, update| {
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

    /// Free a soundfont's blob when its `SoundfontFileBox` is removed. Unlike samples, soundfonts are REQUESTED
    /// reactively (when a device's `file` pointer resolves, in `resolve_and_deliver_soundfont`), not proactively
    /// per box — so this only needs the free half, to release the blob storage on delete.
    fn observe_soundfont_files(&mut self) {
        self.graph.subscribe_box_lifecycle(Box::new(|_graph, update| {
            if let Update::Delete {uuid, name, ..} = update {
                if name == "SoundfontFileBox" {
                    unsafe { SOUNDFONTS.get() }.free(*uuid);
                }
            }
        }));
    }
}

/// Serialize the transport state into `state` (big-endian, per the EngineState contract). The count-in
/// remainder mirrors TS: `(recordingStartTime - position) / PPQN.fromSignature(1, denominator)` beats.
fn write_engine_state(transport: &Transport, state: &mut [u8], is_recording: bool, is_counting_in: bool,
                      recording_start: f64, denominator: i32) {
    state[STATE_POSITION..STATE_POSITION + 4].copy_from_slice(&(transport.position() as f32).to_be_bytes());
    state[STATE_BPM..STATE_BPM + 4].copy_from_slice(&transport.bpm().to_be_bytes());
    state[STATE_PLAYBACK_TIMESTAMP..STATE_PLAYBACK_TIMESTAMP + 4].copy_from_slice(&0f32.to_be_bytes());
    let count_in_remaining = if is_counting_in {
        ((recording_start - transport.position()) / dsp::ppqn::from_signature(1, denominator.max(1))) as f32
    } else {
        0.0
    };
    state[STATE_COUNT_IN_REMAINING..STATE_COUNT_IN_REMAINING + 4].copy_from_slice(&count_in_remaining.to_be_bytes());
    state[STATE_IS_PLAYING] = transport.is_playing() as u8;
    state[STATE_IS_COUNTING_IN] = is_counting_in as u8;
    state[STATE_IS_RECORDING] = is_recording as u8;
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

// ---- render-loop PROFILER (diagnostic) -------------------------------------------------------------------
// `host_perf_now` is the engine's ONE env import (a micros clock, `performance.now() * 1000`): every engine
// loader must bind it. It is only CALLED while profiling is enabled, so the render hot path stays untouched
// by default (the context branches once per quantum).

#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn host_perf_now() -> f64;
}

#[cfg(target_family = "wasm")]
fn perf_now() -> f64 {
    unsafe { host_perf_now() }
}

#[cfg(not(target_family = "wasm"))]
fn perf_now() -> f64 {
    0.0
}

// ---- live-telemetry BROADCAST TABLE (plans/wasm-audio/live-broadcaster.md) -------------------------------

/// Bumps whenever the broadcast table changed (a register or a sweep); the worklet re-reads the table then.
#[no_mangle]
pub extern "C" fn broadcast_generation() -> u32 {
    unsafe { ENGINE.get().as_ref().map_or(0, |engine| engine.broadcasts.generation()) }
}

#[no_mangle]
pub extern "C" fn broadcast_count() -> u32 {
    unsafe { ENGINE.get().as_ref().map_or(0, |engine| engine.broadcasts.len() as u32) }
}

/// Write entry `index` as a fixed 48-byte record to `out_ptr` (client-reserved via `input_reserve`):
/// `[uuid 16][package_type u32][ptr u32][len u32][keys_count u32][keys u16 x 8]`. Returns 1, or 0 when out
/// of range OR when the entry's owning slot died (its `ptr` points into freed heap — serving it would hand
/// the worklet a view over allocator garbage; the next sweep drops it).
#[no_mangle]
pub extern "C" fn broadcast_entry(index: u32, out_ptr: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_ref() else { return 0 };
        let Some(entry) = engine.broadcasts.entry(index as usize) else { return 0 };
        if !entry.alive() { return 0 }
        let out = core::slice::from_raw_parts_mut(out_ptr as *mut u8, 48);
        out[..16].copy_from_slice(&entry.uuid);
        out[16..20].copy_from_slice(&entry.package_type.to_le_bytes());
        out[20..24].copy_from_slice(&entry.ptr.to_le_bytes());
        out[24..28].copy_from_slice(&entry.len.to_le_bytes());
        let keys_count = entry.keys.len().min(8) as u32;
        out[28..32].copy_from_slice(&keys_count.to_le_bytes());
        for (position, key) in entry.keys.iter().take(8).enumerate() {
            let at = 32 + position * 2;
            out[at..at + 2].copy_from_slice(&key.to_le_bytes());
        }
        1
    }
}

/// Diagnostic LEAK PROBE (off the render path, used by `test/heap-cycle-probe.test.ts`): write container
/// sizes as 14 u32s to `out_ptr` (client-reserved):
/// [processors, labels, queue_len, queue_cap, next_node_id, output_registry, graph_vertices,
///  box_count, subscription_count, broadcasts, audio_units, output_registry_engine,
///  sample_slots_ever, sample_slots_live].
#[no_mangle]
pub extern "C" fn debug_probe(out_ptr: u32) {
    unsafe {
        let Some(engine) = ENGINE.get().as_ref() else { return };
        let out = core::slice::from_raw_parts_mut(out_ptr as *mut u32, 14);
        let context = engine.context.debug_counts();
        out[..7].copy_from_slice(&context);
        out[7] = engine.graph.box_count() as u32;
        out[8] = engine.graph.subscription_count() as u32;
        out[9] = engine.broadcasts.len() as u32;
        out[10] = engine.audio_units.len() as u32;
        out[11] = engine.output_registry.len() as u32;
        let (slots_ever, slots_live) = SAMPLES.get().debug_counts();
        out[12] = slots_ever;
        out[13] = slots_live;
    }
}

/// The UI's subscription flag round-trip (a producer MAY skip cold work; meters are always-on today).
#[no_mangle]
pub extern "C" fn broadcast_set_active(index: u32, active: u32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.broadcasts.set_active(index as usize, active != 0);
            // Mirror into the DEVICE broadcast registry (matched by slot ptr) so a plugin's
            // `host_broadcast_active` sees the subscription without touching `ENGINE`.
            if let Some(entry) = engine.broadcasts.entry(index as usize) {
                let ptr = entry.ptr;
                for slot in DEVICE_BROADCASTS.get().iter_mut() {
                    if slot.0 == ptr {
                        slot.1 = active != 0;
                    }
                }
            }
        }
    }
}

/// Enable (or re-zero) per-node render profiling.
#[no_mangle]
pub extern "C" fn profile_enable() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.context.profile_enable(perf_now);
        }
    }
}

/// Write the profile as a UTF-8 text table into `out_ptr` (client-reserved via `input_reserve`), sorted by
/// accumulated time descending: `micros<TAB>label` per line, headed by `quanta <n>`. Returns bytes written
/// (truncated to `max`). Diagnostic path, allocation is fine here.
#[no_mangle]
pub extern "C" fn profile_report(out_ptr: u32, max: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_mut() else { return 0 };
        let (mut entries, quanta) = engine.context.profile_report();
        entries.sort_unstable_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(core::cmp::Ordering::Equal));
        let mut text = alloc::format!("quanta {}\n", quanta);
        for (label, micros) in entries {
            text.push_str(&alloc::format!("{micros:.1}\t{label}\n"));
        }
        let bytes = text.as_bytes();
        let count = bytes.len().min(max as usize);
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr as *mut u8, count);
        count as u32
    }
}

/// Refresh the 32-byte checksum buffer from the current graph and return its pointer. Computing the
/// checksum is a full-graph walk (O(all boxes)), so it runs ONLY here — on the throttled verification
/// round-trip (~1/s), never per transaction. Called from the worklet's checksum-verify path.
#[no_mangle]
pub extern "C" fn checksum_ptr() -> *const u8 {
    unsafe {
        if let Some(engine) = ENGINE.get().as_ref() {
            CHECKSUM.get().copy_from_slice(&engine.checksum());
        }
        CHECKSUM.get().as_ptr()
    }
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
        *BASE_FREQUENCY.get() = 440.0; // back to the default until the next session's `bind` catches up
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
            Ok(()) => {
                engine.reconcile_units(); // apply any audio-unit membership change this transaction recorded
                engine.sync_midi_targets(); // realize any MIDIOutputBox joins / leaves this transaction recorded
                0
            }
            Err(()) => 1
        }
    }
}

/// Initialize the engine for `sample_rate`: empty graph, a STOPPED transport (the UI starts playback with
/// `play`), and a metronome.
#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let engine = Engine::new(sample_rate);
    unsafe {
        *ENGINE.get() = Some(engine);
        INPUT.get().reserve(INPUT_CAPACITY); // pre-allocate the input scratch (len stays 0; this is capacity)
        PULL.get().scratch.reserve(DEVICE_MAX_EVENTS); // the note-pull scratch never grows past the device's cap
    }
}

/// Render one 128-frame quantum into the output buffer and refresh the EngineState back-channel.
#[no_mangle]
pub extern "C" fn render() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.render(OUTPUT.get(), ENGINE_STATE.get());
            engine.copy_monitor_outputs();
            engine.copy_stem_outputs();
        }
    }
}

/// Configure a STEM EXPORT (TS `exportConfiguration.stems`): `count` records of `[unit uuid 16][flags u32
/// LE]` (bit0 includeAudioEffects, bit1 includeSends, bit2 useInstrumentOutput, bit3 skipChannelStrip) in
/// the input scratch, in EXPORT ORDER. Call BEFORE `bind` (an offline render configures once); allocates
/// the staging each render fills (stem i -> planar channels 2i / 2i+1 at `stem_output_ptr`).
/// `metronome_stem` (TS `exportConfiguration.metronome.stem`) appends the metronome as one further pair
/// AFTER the unit stems, so it is part of the same allocation rather than a second call that could leave the
/// staging a pair short.
#[no_mangle]
pub extern "C" fn set_stem_export(count: u32, metronome_stem: u32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.metronome_stem = metronome_stem != 0;
            let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), count as usize * 20);
            let mut stems = Vec::with_capacity(count as usize);
            for index in 0..count as usize {
                let record = &bytes[index * 20..index * 20 + 20];
                let mut uuid = [0u8; 16];
                uuid.copy_from_slice(&record[..16]);
                let flags = u32::from_le_bytes([record[16], record[17], record[18], record[19]]);
                stems.push(StemEntry {
                    uuid,
                    include_audio_effects: flags & 1 != 0,
                    include_sends: flags & 2 != 0,
                    use_instrument_output: flags & 4 != 0,
                    skip_channel_strip: flags & 8 != 0
                });
            }
            let pairs = stems.len() + usize::from(engine.metronome_stem);
            engine.stem_staging = alloc::vec![0.0; pairs * 2 * RENDER_QUANTUM];
            engine.stem_exports = stems;
        }
    }
}

/// FREEZE step 1 (TS `EngineCommands.setFrozenAudio`): allocate the pending PCM buffer (ALWAYS
/// `frame_count * 2` f32, the final planar stereo layout) and return its write pointer; the writer fills
/// plane 0 (and plane 1 when stereo), then calls `set_frozen_audio` with the unit uuid in the input scratch.
#[no_mangle]
pub extern "C" fn frozen_allocate(frame_count: u32, _channels: u32) -> *mut f32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => {
                engine.frozen_pending = alloc::vec![0.0; frame_count as usize * 2];
                engine.frozen_pending.as_mut_ptr()
            }
            None => core::ptr::null_mut()
        }
    }
}

/// FREEZE step 2: attach the pending PCM (written planar into the `frozen_allocate` buffer) to the unit
/// whose 16-byte uuid sits in the input scratch, and re-wire it to frozen playback. Takes the pending
/// buffer AS-IS (no allocation, no copy — it already has the stereo layout); a mono freeze duplicates
/// plane 0 into plane 1 in place.
#[no_mangle]
pub extern "C" fn set_frozen_audio(frame_count: u32, channels: u32, sample_rate: f32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            let mut uuid = [0u8; 16];
            uuid.copy_from_slice(core::slice::from_raw_parts(INPUT.get().as_ptr(), 16));
            let frame_count = frame_count as usize;
            let mut frames = core::mem::take(&mut engine.frozen_pending);
            if channels < 2 {
                frames.copy_within(..frame_count, frame_count);
            }
            engine.set_frozen_audio(uuid, Rc::new(frozen::FrozenData {frames, frame_count, sample_rate}));
        }
    }
}

/// UNFREEZE (TS `setFrozenAudio(uuid, null)`): drop the unit's frozen PCM (uuid in the input scratch) and
/// re-wire its live chain.
#[no_mangle]
pub extern "C" fn clear_frozen_audio() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            let mut uuid = [0u8; 16];
            uuid.copy_from_slice(core::slice::from_raw_parts(INPUT.get().as_ptr(), 16));
            engine.clear_frozen_audio(uuid);
        }
    }
}

/// The stem staging base pointer (`stems * 2 * 128` f32, planar per stem).
#[no_mangle]
pub extern "C" fn stem_output_ptr() -> *const f32 {
    unsafe {
        match ENGINE.get().as_ref() {
            Some(engine) => engine.stem_staging.as_ptr(),
            None => core::ptr::null()
        }
    }
}

/// The EFFECTS-monitoring INPUT staging (`MONITOR_CHANNELS * 128` f32, channel-planar): the worklet writes
/// the live input channels here BEFORE each `render`.
#[no_mangle]
pub extern "C" fn monitor_input_ptr() -> *mut f32 {
    unsafe { MONITOR_INPUT.get().as_mut_ptr() }
}

/// The EFFECTS-monitoring OUTPUT staging (same layout): each mapped unit's strip output lands here after
/// `render`; the worklet forwards it on its second output (the MonitoringRouter return).
#[no_mangle]
pub extern "C" fn monitor_output_ptr() -> *const f32 {
    unsafe { MONITOR_OUTPUT.get().as_ptr() }
}

/// Replace the EFFECTS-monitoring map (TS `EngineCommands.updateMonitoringMap`): `count` records of
/// `[unit uuid 16][left channel i32 LE][right channel i32 LE]` (right -1 = mono) in the input scratch.
/// Every unit leaving or joining the map re-wires (the `MonitorMix` injector joins / leaves its chain).
#[no_mangle]
pub extern "C" fn set_monitoring_map(count: u32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), count as usize * 24);
            let mut map = Vec::with_capacity(count as usize);
            for index in 0..count as usize {
                let record = &bytes[index * 24..index * 24 + 24];
                let mut uuid = [0u8; 16];
                uuid.copy_from_slice(&record[..16]);
                let left = i32::from_le_bytes([record[16], record[17], record[18], record[19]]);
                let right = i32::from_le_bytes([record[20], record[21], record[22], record[23]]);
                map.push(monitor::MonitorEntry {uuid, left, right});
            }
            engine.set_monitoring_map(map);
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
pub extern "C" fn pause() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.pause()
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

/// Arm recording (TS `EngineCommands.prepareRecordingState`): `count_in_bars` comes from the caller's
/// preferences (the engine owns the signature). See `Engine::prepare_recording_state`.
#[no_mangle]
pub extern "C" fn prepare_recording_state(count_in: i32, count_in_bars: f64) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.prepare_recording_state(count_in != 0, count_in_bars);
        }
    }
}

/// End recording (TS `EngineCommands.stopRecording`): drops the flags and pauses the transport.
#[no_mangle]
pub extern "C" fn stop_recording() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.stop_recording();
        }
    }
}

/// Exclude a note region from playback (TS `EngineCommands.ignoreNoteRegion`): the region currently being
/// RECORDED INTO must not re-trigger the notes being captured. The 16-byte region uuid is written into the
/// input scratch first. Cleared on stop / stopRecording.
#[no_mangle]
pub extern "C" fn ignore_note_region() {
    let mut uuid = [0u8; 16];
    uuid.copy_from_slice(unsafe { core::slice::from_raw_parts(INPUT.get().as_ptr(), 16) });
    let ignored = unsafe { IGNORED_REGIONS.get() };
    if !ignored.contains(&uuid) {
        ignored.push(uuid);
    }
}

#[no_mangle]
pub extern "C" fn set_position(position: f64) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.set_position(position)
        }
    }
}

/// The 16-byte target uuid the host wrote into the input buffer (the `device_set_box_type` convention).
fn input_uuid() -> Uuid {
    let mut uuid: Uuid = [0; 16];
    unsafe { uuid.copy_from_slice(core::slice::from_raw_parts(INPUT.get().as_ptr(), 16)); }
    uuid
}

/// LIVE note signals (the studio's on-screen keys / pads / MIDI input, TS `EngineCommands.noteSignal`):
/// the host writes the target `AudioUnitBox` uuid into the input buffer (16 bytes) first, then calls one
/// of these. A raw note-on sustains until its note-off; an audition stops itself after `duration` pulses.
/// They sound while the transport is stopped too (the paused render keeps the pulse range advancing).
/// CLIP LAUNCHING (TS `EngineCommands.scheduleClipPlay` / `scheduleClipStop`): the host writes the
/// 16-byte uuid into the input buffer first. `schedule_clip_play` takes a CLIP uuid (its track resolves
/// through the clip's `clips` pointer, key 1); `schedule_clip_stop` takes a TRACK uuid. Transitions queue
/// for `clip_changes_take`: records of [uuid 16][kind u32 LE] (0 started, 1 stopped, 2 obsolete), feeding
/// the notifyClipSequenceChanges back-channel.
#[no_mangle]
pub extern "C" fn schedule_clip_play() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.schedule_clip_play(input_uuid());
        }
    }
}

#[no_mangle]
pub extern "C" fn schedule_clip_stop() {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.clip_sequencer.borrow_mut().schedule_stop(input_uuid());
        }
    }
}

#[no_mangle]
pub extern "C" fn clip_changes_count() -> u32 {
    unsafe {
        match ENGINE.get().as_ref() {
            Some(engine) => engine.clip_sequencer.borrow().changes_len() as u32,
            None => 0
        }
    }
}

#[no_mangle]
pub extern "C" fn clip_changes_take(out_ptr: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_mut() else { return 0 };
        let mut count: u32 = 0;
        let base = out_ptr as usize;
        engine.clip_sequencer.borrow_mut().take_changes(&mut |uuid, change| {
            let record = core::slice::from_raw_parts_mut((base + count as usize * 20) as *mut u8, 20);
            record[..16].copy_from_slice(uuid);
            let kind: u32 = match change {
                engine_env::clip_sequencer::Change::Started => 0,
                engine_env::clip_sequencer::Change::Stopped => 1,
                engine_env::clip_sequencer::Change::Obsolete => 2
            };
            record[16..20].copy_from_slice(&kind.to_le_bytes());
            count += 1;
        });
        count
    }
}

/// MARKER-STATE notifications (TS `EngineToClient.switchMarkerState([uuid, count] | null)`): the
/// transport raises a change whenever the active marker or its play count moved (a section repeat, a
/// fall-through, a seek into another section). Changes queue as 24-byte records
/// [uuid 16][count u32 LE][flag u32 LE: 1 active marker, 0 none] drained via `marker_changes_take`
/// (the clip-changes pattern; reserve `marker_changes_count() * 24` input bytes first).
#[no_mangle]
pub extern "C" fn marker_changes_count() -> u32 {
    unsafe {
        match ENGINE.get().as_ref() {
            Some(engine) => engine.marker_changes.len() as u32,
            None => 0
        }
    }
}

#[no_mangle]
pub extern "C" fn marker_changes_take(out_ptr: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_mut() else { return 0 };
        let base = out_ptr as usize;
        let count = engine.marker_changes.len() as u32;
        for (index, (uuid, plays, active)) in engine.marker_changes.drain(..).enumerate() {
            let record = core::slice::from_raw_parts_mut((base + index * 24) as *mut u8, 24);
            record[..16].copy_from_slice(&uuid);
            record[16..20].copy_from_slice(&(plays as u32).to_le_bytes());
            record[20..24].copy_from_slice(&(active as u32).to_le_bytes());
        }
        count
    }
}

/// MIDI-OUT drain (TS `MIDISender.send` feed): the queued messages of every MIDI-output unit + the
/// transport clock, drained once per quantum by the worklet into the studio's unchanged MIDISender ring.
/// WASM CONTRACT: 16-byte records [device u32 LE][status u8][data1 u8][data2 u8][length u8][timeMs f64 LE]
/// (reserve `midi_out_count() * 16` input bytes first). `device` resolves to the `MIDIOutputBox.id` string
/// via `midi_out_device_id` (UTF-8 written to out_ptr, byte length returned; 0 = unknown number) — numbers
/// are stable first-seen indices, so the worklet caches the mapping.
#[no_mangle]
pub extern "C" fn midi_out_count() -> u32 {
    unsafe {
        match ENGINE.get().as_ref() {
            Some(engine) => engine.midi_out.borrow().queue_len() as u32,
            None => 0
        }
    }
}

#[no_mangle]
pub extern "C" fn midi_out_take(out_ptr: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_mut() else { return 0 };
        let base = out_ptr as usize;
        let mut index = 0usize;
        engine.midi_out.borrow_mut().drain_queue(|msg| {
            let record = core::slice::from_raw_parts_mut((base + index * 16) as *mut u8, 16);
            record[..4].copy_from_slice(&msg.device.to_le_bytes());
            record[4] = msg.status;
            record[5] = msg.data1;
            record[6] = msg.data2;
            record[7] = msg.len;
            record[8..16].copy_from_slice(&msg.time_ms.to_le_bytes());
            index += 1;
        })
    }
}

#[no_mangle]
pub extern "C" fn midi_out_device_id(num: u32, out_ptr: u32, max: u32) -> u32 {
    unsafe {
        let Some(engine) = ENGINE.get().as_ref() else { return 0 };
        let midi = engine.midi_out.borrow();
        let Some(id) = midi.device_id(num) else { return 0 };
        let bytes = id.as_bytes();
        let len = bytes.len().min(max as usize);
        core::slice::from_raw_parts_mut(out_ptr as *mut u8, len).copy_from_slice(&bytes[..len]);
        len as u32
    }
}

#[no_mangle]
pub extern "C" fn note_signal_on(pitch: u32, velocity: f32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_ref() {
            engine.note_signal(input_uuid(), audio_unit::NoteSignal::On {pitch: pitch as u8, velocity})
        }
    }
}

#[no_mangle]
pub extern "C" fn note_signal_off(pitch: u32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_ref() {
            engine.note_signal(input_uuid(), audio_unit::NoteSignal::Off {pitch: pitch as u8})
        }
    }
}

#[no_mangle]
pub extern "C" fn note_signal_audition(pitch: u32, duration: f64, velocity: f32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_ref() {
            engine.note_signal(input_uuid(), audio_unit::NoteSignal::Audition {pitch: pitch as u8, duration, velocity})
        }
    }
}

/// TS `settings.recording.allowTakes`: while recording WITHOUT takes the loop wrap is suppressed.
#[no_mangle]
pub extern "C" fn set_allow_takes(enabled: i32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.allow_takes = enabled != 0
        }
    }
}

/// TS `settings.playback.pauseOnLoopDisabled`: reaching the loop end PAUSES instead of wrapping.
#[no_mangle]
pub extern "C" fn set_pause_on_loop_disabled(enabled: i32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.pause_on_loop_disabled = enabled != 0
        }
    }
}

/// The `playback.truncateNotesAtRegionEnd` preference (TS `NoteSequencer` reads it live per block).
#[no_mangle]
pub extern "C" fn set_truncate_notes_at_region_end(enabled: i32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_ref() {
            engine.truncate_pref.set(enabled != 0)
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

/// The metronome preferences (TS `preferences.settings.metronome`), forwarded by the worklet's
/// engine-preferences subscriptions: click gain in dB (<= 0).
#[no_mangle]
pub extern "C" fn set_metronome_gain(gain_db: f32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.metronome.set_gain(gain_db)
        }
    }
}

/// Beat sub-division (1 | 2 | 4 | 8): clicks every `1 / (denominator * division)` note.
#[no_mangle]
pub extern "C" fn set_metronome_beat_sub_division(division: u32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.metronome.set_beat_sub_division(division)
        }
    }
}

/// Monophonic clicks: a new click fades every sounding one out over 5 ms (TS `Click.fadeOut`).
#[no_mangle]
pub extern "C" fn set_metronome_monophonic(enabled: i32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            engine.metronome.set_monophonic(enabled != 0)
        }
    }
}

/// CLICK-SOUND upload step 1 (TS `EngineCommands.loadClickSound`, the frozen-audio pattern): allocate
/// the pending PCM buffer (`frame_count * channels` f32, planar) and return its write pointer; the
/// worklet fills the planes, then calls `set_click_sound`.
#[no_mangle]
pub extern "C" fn click_allocate(frame_count: u32, channels: u32) -> *mut f32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => {
                engine.click_pending = alloc::vec![0.0; frame_count as usize * channels.clamp(1, 2) as usize];
                engine.click_pending.as_mut_ptr()
            }
            None => core::ptr::null_mut()
        }
    }
}

/// CLICK-SOUND upload step 2: hand the pending PCM to the metronome as click `index` (0 downbeat,
/// 1 beat), keeping the sound's own sample rate (playback resamples like the TS `Click`).
#[no_mangle]
pub extern "C" fn set_click_sound(index: u32, frame_count: u32, channels: u32, sample_rate: f32) {
    unsafe {
        if let Some(engine) = ENGINE.get().as_mut() {
            let frames = core::mem::take(&mut engine.click_pending);
            engine.metronome.load_click_sound(index as usize,
                metronome::ClickSound::new(frames, frame_count as usize, channels.clamp(1, 2) as usize, sample_rate));
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
/// `init_index` / `parameter_changed_index` / `reset_index` / `terminate_index` its lifecycle-hook slots (0
/// when the device exports none). `terminate_index` fires once, only when the device's INSTANCE dies (a
/// genuine removal), never on a chain-edit survivor. Returns the device id. Call once per device, before
/// `bind` (which builds the graph and wires devices).
#[no_mangle]
#[allow(clippy::too_many_arguments)] // one positional arg per device export, matching the loader's call
pub extern "C" fn device_register(process_index: u32, state_size: u32, kind: u32, init_index: u32, parameter_changed_index: u32, field_changed_index: u32, sample_changed_index: u32, soundfont_changed_index: u32, reset_index: u32, terminate_index: u32, midi_effects_field: u32, audio_effects_field: u32, param_collection_field: u32, sample_collection_field: u32) -> u32 {
    unsafe {
        match ENGINE.get().as_mut() {
            Some(engine) => engine.device_register(process_index, state_size, kind, init_index, parameter_changed_index, field_changed_index, sample_changed_index, soundfont_changed_index, reset_index, terminate_index, midi_effects_field, audio_effects_field, param_collection_field, sample_collection_field),
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
#[allow(clippy::too_many_arguments)]
pub extern "C" fn composite_register(name_len: usize, children_field: u32, index_key: u32, exclude_key: u32,
                                     cell_instrument_field: u32, cell_midi_field: u32, cell_audio_field: u32, child_enabled_key: u32,
                                     child_mute_key: u32, child_solo_key: u32) {
    unsafe {
        let engine = match ENGINE.get().as_mut() {
            Some(engine) => engine,
            None => return
        };
        let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), name_len);
        if let Ok(name) = core::str::from_utf8(bytes) {
            engine.register_composite(String::from(name), children_field as u16, index_key as u16, exclude_key as u16,
                cell_instrument_field as u16, cell_midi_field as u16, cell_audio_field as u16, child_enabled_key as u16,
                child_mute_key as u16, child_solo_key as u16);
        }
    }
}

/// Register an EFFECT composite box type (a parallel fx / note stack): its entry collection + the entry box's
/// field keys + the composite's dry / wet + input tap. The sibling of `composite_register`; the engine reads no
/// specifics beyond this record, so a new split container needs no engine change.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn effect_composite_register(name_len: usize, kind: u32, distributor: u32, entries_field: u32,
                                            index_key: u32, chain_field: u32, label_key: u32, gain_key: u32,
                                            pan_key: u32, mute_key: u32, solo_key: u32, dry_key: u32, wet_key: u32,
                                            input_tap_field: u32) {
    unsafe {
        let engine = match ENGINE.get().as_mut() {
            Some(engine) => engine,
            None => return
        };
        let bytes = core::slice::from_raw_parts(INPUT.get().as_ptr(), name_len);
        if let Ok(name) = core::str::from_utf8(bytes) {
            engine.register_effect_composite(String::from(name), kind as u8, Distributor::from_u32(distributor),
                entries_field as u16, index_key as u16, chain_field as u16, label_key as u16, gain_key as u16,
                pan_key as u16, mute_key as u16, solo_key as u16, dry_key as u16, wet_key as u16,
                input_tap_field as u16);
        }
    }
}

/// Resolve an `AudioFileBox` uuid to its frames for an ENGINE-SIDE reader (the audio-region player) during
/// render. Reads the `SAMPLES` cell read-only, exactly like `host_resolve_sample`, so it never aliases the
/// `&mut Engine` the render path holds.
pub(crate) fn resolve_sample(uuid: boxgraph::address::Uuid) -> Option<abi::SampleRef> {
    unsafe { SAMPLES.get() }.resolve_uuid(uuid)
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

/// Resolve a soundfont handle for a device DURING render: write a `SoundfontRef` (ptr + len) to `out_ptr` and
/// return 1 if the blob is resident (ready), else 0. Bound into each device's `env`; reads the `SOUNDFONTS`
/// cell read-only, so it never aliases the `&mut Engine` the render path holds. Mirrors `host_resolve_sample`.
#[no_mangle]
pub extern "C" fn host_resolve_soundfont(handle: u32, out_ptr: u32) -> u32 {
    match unsafe { SOUNDFONTS.get() }.resolve(handle) {
        Some(soundfont_ref) => {
            unsafe { *(out_ptr as *mut abi::SoundfontRef) = soundfont_ref; }
            1
        }
        None => 0
    }
}

/// Pop the next soundfont awaiting a load (queued on seeing a `SoundfontFileBox` target): write its 16-byte
/// uuid to `out_ptr` and return its handle, or -1 when none pending. The worklet drains these after applying a
/// transaction and dispatches each to the main-thread soundfont loader. Off-render.
#[no_mangle]
pub extern "C" fn soundfont_take_request(out_ptr: u32) -> i32 {
    match unsafe { SOUNDFONTS.get() }.take_pending() {
        Some((handle, uuid)) => {
            unsafe { core::ptr::copy_nonoverlapping(uuid.as_ptr(), out_ptr as *mut u8, 16); }
            handle as i32
        }
        None => -1
    }
}

/// Reserve `byte_len` zeroed bytes for the soundfont blob and return the pointer the loader writes into.
/// Off-render (the worklet calls it once the loader reports the built blob size).
#[no_mangle]
pub extern "C" fn soundfont_allocate(handle: u32, byte_len: u32) -> u32 {
    unsafe { SOUNDFONTS.get() }.allocate(handle, byte_len as usize)
}

/// Mark a soundfont ready once the loader has written its blob. After this the soundfont resolves for the
/// device. Off-render.
#[no_mangle]
pub extern "C" fn soundfont_set_ready(handle: u32) {
    unsafe { SOUNDFONTS.get() }.set_ready(handle);
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

// The panic MESSAGE buffer: the handler formats the panic (message + location) here BEFORE trapping, and
// the worklet reads it back via `panic_message_ptr/len` after catching the RuntimeError — so a production
// panic is never anonymous (panic=abort + strip discard the message and the function names otherwise).
// A fixed static, no alloc: the allocator may be the very thing that panicked.
const PANIC_MESSAGE_CAPACITY: usize = 512;
static PANIC_MESSAGE: Shared<([u8; PANIC_MESSAGE_CAPACITY], usize)> =
    Shared::new(([0; PANIC_MESSAGE_CAPACITY], 0));

struct PanicWriter {
    buffer: &'static mut [u8],
    written: usize
}

impl core::fmt::Write for PanicWriter {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        let bytes = text.as_bytes();
        let count = bytes.len().min(self.buffer.len() - self.written);
        self.buffer[self.written..self.written + count].copy_from_slice(&bytes[..count]);
        self.written += count;
        Ok(()) // truncate silently; a clipped message still names the panic
    }
}

#[no_mangle]
pub extern "C" fn panic_message_ptr() -> *const u8 {
    unsafe { PANIC_MESSAGE.get() }.0.as_ptr()
}

#[no_mangle]
pub extern "C" fn panic_message_len() -> usize {
    unsafe { PANIC_MESSAGE.get() }.1
}

/// Host import a DEVICE's panic handler calls to deposit ITS panic message before trapping (the abi crate's
/// shared handler): copied into the same buffer the worklet reads. Writes nothing else, safe at any time.
#[no_mangle]
pub extern "C" fn host_panic(msg_ptr: u32, msg_len: u32) {
    let (buffer, written) = unsafe { PANIC_MESSAGE.get() };
    let count = (msg_len as usize).min(PANIC_MESSAGE_CAPACITY);
    unsafe { core::ptr::copy_nonoverlapping(msg_ptr as *const u8, buffer.as_mut_ptr(), count); }
    *written = count;
}

#[cfg(not(test))]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    use core::fmt::Write;
    let (buffer, written) = unsafe { PANIC_MESSAGE.get() };
    let mut writer = PanicWriter {buffer, written: 0};
    let _ = write!(writer, "{}", info); // Display = "panicked at <file>:<line>: <message>"
    *written = writer.written;
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
        events.sort_unstable_by(compare_lifecycle);
        // at position 0: note-off -> param-update -> note-on; then the position-10 note-on.
        assert_eq!(kinds(&events), vec!["off", "param", "on", "on"]);
    }

    #[test]
    fn earlier_position_always_precedes_regardless_of_kind() {
        let mut events = [note_on(5.0), note_off(20.0), update(1.0)];
        events.sort_unstable_by(compare_lifecycle);
        assert_eq!(events.iter().map(Event::position).collect::<Vec<_>>(), vec![1.0, 5.0, 20.0]);
    }
}
