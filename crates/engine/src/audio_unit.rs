//! The audio-unit cascade: ONE place for everything beneath the RootBox `audio-units`, mirroring the box
//! hierarchy AudioUnitBox -> TrackBox -> RegionBox -> NoteEventCollection -> events. Everything here is
//! reactive (catch-up + subscribe), so a main-thread edit at any level reaches the running engine:
//!
//!   - `AudioUnitBinding`: per `AudioUnitBox`. Holds the device chains (three `IndexedCollection`s — the
//!     `input` instrument, the `midi-effects` and `audio-effects` chains, each ordered by device `index`),
//!     the shared region set the sequencer reads, and the wired processor cluster (rebuilt only when a
//!     chain reports dirty).
//!   - `TrackBinding`: per `TrackBox`, observing its `regions`.
//!   - `RegionBinding`: per region, observing its `NoteEventCollection`.
//!
//! The `impl Engine` methods here own the unit lifecycle (build / rewire / teardown + the per-transaction
//! `reconcile`); the free functions own the track/region cascade (graph-only, no processor wiring). The
//! engine struct + its render path stay in `lib.rs`; this module is the structure beneath a unit.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::{DEVICE_KIND_AUDIO_EFFECT, DEVICE_KIND_INSTRUMENT, DEVICE_KIND_MIDI_EFFECT, FIELD_KIND_BOOL, FIELD_KIND_FLOAT, FIELD_KIND_INT, FIELD_KIND_STRING, PARAM_KIND_BOOL, PARAM_KIND_FLOAT, PARAM_KIND_INT};
use bindings::indexed_collection::IndexedCollection;
use bindings::note_collection::NoteCollection;
use bindings::value_collection::ValueCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, Propagation, SubscriptionId};
use engine_env::audio_buffer::SharedAudioBuffer;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::channel_strip::{ChannelStripProcessor, StripParams};
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::note_region_source::NoteRegionSource;
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;
use value::region::{RegionCollection, Span};
use crate::param_automation::{FieldPath, ParamCurve, ParamHandle, ParamSink, ValueBoundRegion};
use crate::plugin_audio_effect::PluginAudioEffect;
use crate::plugin_instrument::PluginInstrument;
use crate::plugin_midi_effect::PluginMidiEffect;
use crate::composite::CompositeBinding;
use crate::{call_device_init, call_device_field_changed, call_device_parameter_changed, call_device_sample_changed, CompositeSpec, DeviceReg, Engine, PullLink, BIND, FIELD_OBS, SAMPLE_OBS, SAMPLES, SIDECHAIN_BIND, EFFECT_INDEX_KEY};

// AudioUnitBox field keys (WASM CONTRACT: mirror the TS AudioUnitBox schema). The unit carries its strip
// params and hosts its instrument / effect chains / tracks at these hub keys.
const UNIT_VOLUME_KEY: u16 = 12;
const UNIT_PANNING_KEY: u16 = 13;
const UNIT_MUTE_KEY: u16 = 14;
const UNIT_TRACKS_KEY: u16 = 20;   // track-membership hub
const UNIT_MIDI_KEY: u16 = 21;     // midi-effect chain host
const UNIT_INPUT_KEY: u16 = 22;    // instrument (input) host
const UNIT_AUDIO_KEY: u16 = 23;    // audio-effect chain host
// RootBox.audio-units hub (unit membership) — a different box, same ordinal.
const ROOT_AUDIO_UNITS_KEY: u16 = 20;
// A unit-level device box's `enabled` BooleanField (WASM CONTRACT: the base device schema; a disabled
// audio / midi effect is bypassed — skipped in the chain wiring). Composite-child enabled is separate.
const DEVICE_ENABLED_KEY: u16 = 4;

/// The handle a unit's subscriptions use to enqueue THAT unit for reconcile when its scope changes, so a
/// related edit reconciles one unit instead of sweeping all units (the Rust analog of TS's per-unit
/// `invalidateWiring`). `units` is the engine's shared `dirty_units` queue; `unit` is this unit's uuid.
#[derive(Clone)]
pub(crate) struct DirtyMark {
    units: Rc<RefCell<Vec<Uuid>>>,
    unit: Uuid
}

impl DirtyMark {
    /// Enqueue this unit (de-duplicated) for the next reconcile.
    fn mark(&self) {
        let mut units = self.units.borrow_mut();
        if !units.contains(&self.unit) {
            units.push(self.unit);
        }
    }

    /// A bare `Fn()` form for the binders (`IndexedCollection`, composite) that take an opaque dirty signal.
    fn signal(&self) -> Rc<dyn Fn()> {
        let mark = self.clone();
        Rc::new(move || mark.mark())
    }
}

/// The signal a unit's PARAMETER subscriptions fire when automation attaches / detaches / edits: set the
/// unit's `automation_dirty` flag and enqueue the unit, so `reconcile_one` re-binds its automation (no
/// rewire). Distinct from `DirtyMark::signal` (chain / sidechain), which only enqueues.
fn automation_invalidate(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
    let dirty = unit.automation_dirty.clone();
    let mark = unit.mark.clone();
    Rc::new(move || {dirty.set(true); mark.mark();})
}

/// One bound note region: its loopable span plus a shared handle to its `NoteEventCollection` (the cache's
/// canonical observation — see `CollectionCache`). Keyed by uuid so the region cascade can remove it.
/// MIRRORED regions reference the same collection box, so their `collection` handles are clones of the one
/// observation: each region has its own span, all read the one ever-sorted event list.
pub(crate) struct BoundRegion {
    region_uuid: Uuid,
    region: NoteRegion,
    collection: NoteCollection
}

impl Span for BoundRegion {
    fn position(&self) -> f64 { self.region.position }
    fn duration(&self) -> f64 { self.region.duration }
}

/// Per-unit cache of observed note-event collections. A `NoteEventCollectionBox` is observed ONCE (one
/// `NoteCollection`, one ever-sorted event list) no matter how many regions reference it (mirrored
/// regions); each referencing region gets a cheap clone of that handle. Ref-counted, so the observation is
/// terminated only when the last region referencing it leaves. Mirrors the TS one-adapter-per-box model.
#[derive(Default)]
struct CollectionCache {
    entries: Vec<CollectionEntry>
}

struct CollectionEntry {
    uuid: Uuid,
    collection: NoteCollection,
    refs: usize
}

impl CollectionCache {
    /// Get a handle to the collection `uuid`, observing it once on first use and bumping its ref count.
    fn acquire(&mut self, graph: &mut BoxGraph, uuid: Uuid) -> NoteCollection {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.uuid == uuid) {
            entry.refs += 1;
            return entry.collection.clone();
        }
        let collection = NoteCollection::observe(graph, uuid);
        self.entries.push(CollectionEntry {uuid, collection: collection.clone(), refs: 1});
        collection
    }

    /// Drop one reference to `uuid`; terminate the observation when the last region leaves.
    fn release(&mut self, graph: &mut BoxGraph, uuid: Uuid) {
        if let Some(index) = self.entries.iter().position(|entry| entry.uuid == uuid) {
            self.entries[index].refs -= 1;
            if self.entries[index].refs == 0 {
                self.entries.remove(index).collection.terminate(graph);
            }
        }
    }

    /// Terminate any remaining observations (a defensive cleanup on unit teardown; normally already empty).
    fn terminate_all(self, graph: &mut BoxGraph) {
        for entry in self.entries {
            entry.collection.terminate(graph);
        }
    }
}

/// ONE track's note regions, kept SORTED BY POSITION (a `RegionCollection`). Scoped to the track because
/// `iterate_range` assumes non-overlapping regions, which holds within a track but not across a unit's
/// tracks. Shared between the track binding (the cascade inserts / removes / re-sorts) and the unit's
/// sequencer (which range-queries it each block).
pub(crate) type SharedTrackRegions = Rc<RefCell<RegionCollection<BoundRegion>>>;

/// The unit's live list of per-track region collections (one entry per `TrackBox`), shared with the
/// sequencer. Tracks are added / removed live; the sequencer iterates whatever is currently present.
pub(crate) type SharedTrackSets = Rc<RefCell<Vec<SharedTrackRegions>>>;

/// The `NoteRegionSource` the unit's sequencer reads. It iterates EACH track's own sorted region collection
/// (unit -> tracks -> regions), range-querying each — mirroring TS `tracks -> regions.collection.iterateRange`.
pub(crate) struct BoundNoteRegions {
    pub(crate) tracks: SharedTrackSets
}

impl NoteRegionSource for BoundNoteRegions {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        for track in self.tracks.borrow().iter() {
            // Binary-search the regions overlapping [from, to) within this track (sorted by position).
            for bound in track.borrow().iterate_range(from, to) {
                visit(&bound.region, &bound.collection.events());
            }
        }
    }
}

/// Pending membership changes a pointer-hub observer records (observers get `&BoxGraph` only, so they
/// cannot mutate the processor graph); the engine drains them while reconciling, where it has `&mut`. Used
/// at every cascade level: the RootBox's audio-units, an audio unit's tracks, a track's regions.
#[derive(Default)]
pub(crate) struct Members {
    pub(crate) added: Vec<Uuid>,
    pub(crate) removed: Vec<Uuid>
}

/// One bound note region in the cascade: its uuid (its entry in the track's region collection), the
/// collection it references (so the cache ref can be released when the region leaves), and a TARGETED
/// `Parent` subscription on the region box that re-sorts the track when this region's own span is edited.
struct RegionBinding {
    region_uuid: Uuid,
    collection_uuid: Uuid,
    edit_sub: SubscriptionId
}

/// A track BINDING: owns this track's sorted region collection (`regions_set`, shared with the sequencer)
/// and observes its `regions` membership (add / remove). A member region's span edit is observed per-region
/// (see `RegionBinding`), so no track-wide listener is needed.
struct TrackBinding {
    track_uuid: Uuid,
    regions_set: SharedTrackRegions,
    region_bindings: Vec<RegionBinding>,
    region_changes: Rc<RefCell<Members>>,
    region_sub: SubscriptionId
}

/// What the engine wired for one unit. A LEAF-instrument unit owns its device processors PERSISTENTLY (the
/// analog of TS `AudioDeviceChain`'s `#effects`): a chain edit keeps the survivors and only creates joiners /
/// terminates leavers, re-wiring EDGES ONLY (the `#disconnector` analog), so no survivor's DSP state is reset.
/// A COMPOSITE-instrument unit keeps the older whole-cluster bundle (its instrument is a child cascade, not a
/// single processor; per-child lifecycle lives in the `composite` module).
enum Wired {
    Leaf(LeafChain),
    Composite(CompositeWired)
}

/// A held device processor, kept alive across rewires so its DSP state (voices, delay tails, filter history)
/// survives a chain edit. The `Rc` is also how a rewire re-points the survivor (`set_audio_source` /
/// `set_pull_chain`) without recreating it.
enum ProcHandle {
    Instrument(Rc<RefCell<PluginInstrument>>),
    Audio(Rc<RefCell<PluginAudioEffect>>),
    Midi(Rc<PluginMidiEffect>)
}

/// One persistent chain member: its device box uuid, the held processor, its graph node (none for a midi-fx,
/// which is folded into the instrument's PULL chain and has no audio node), its audio output (for wiring the
/// next node), its bound parameters (bound ONCE on join, reused untouched on survive — re-binding re-runs the
/// device `init`, which resets DSP), and an audio-fx's optional sidechain binding.
struct Member {
    uuid: Uuid,
    proc: ProcHandle,
    node_id: Option<NodeId>,
    output: Option<SharedAudioBuffer>,
    params: DeviceParams,
    sidechain: Option<SidechainBinding>,
    // A TARGETED `This` monitor on the device's `enabled` field: toggling it re-wires the unit (edge-only —
    // a disabled effect is skipped in the chain, its processor + params + DSP state left untouched).
    enabled_sub: SubscriptionId
}

/// A leaf unit's persistent chain: the instrument, its midi-fx (pull-chain order) and audio-fx (graph order)
/// members, the channel strip, and the CURRENT edge set (rebuilt edge-only each reconcile). Members persist
/// across reconciles; only the diff (joiners / leavers) and the edges change.
struct LeafChain {
    instrument: Member,
    // The instrument's note SOURCE. It holds per-block state (notes retained across blocks), so it persists
    // and is REUSED while the instrument survives — recreating it mid-play would drop the held notes (stuck /
    // re-triggered notes). Rebuilt only when the instrument itself changes.
    sequencer: SharedNoteEventSource,
    midi: Vec<Member>,
    audio: Vec<Member>,
    strip: Rc<RefCell<ChannelStripProcessor>>,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    edges: Vec<(NodeId, NodeId)>
}

/// A composite-instrument unit's wiring: the persistent per-child `CompositeBinding` (which owns the children's
/// processors, params, and sidechains, and reconciles them per child), plus the unit's own tail — the channel
/// strip and the `sum -> strip -> master` edges. The strip persists across child edits (the sum bus is stable).
struct CompositeWired {
    binding: CompositeBinding,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    tail_edges: Vec<(NodeId, NodeId)> // sum -> strip, strip -> master
}

/// The reusable result of `build_cluster`: an instrument plus its midi-fx pull chain and audio-fx chain,
/// wired into the global graph. `output` is the chain's final buffer and `output_node` its last node, so a
/// caller appends its own tail (an audio unit appends the channel strip -> master; a composite child appends
/// the per-child sum). The bookkeeping (`nodes` / `edges` / `device_params` / `device_uuids`) folds into the
/// caller's `WiredCluster` and the unit's automation set.
pub(crate) struct BuiltCluster {
    pub(crate) output: SharedAudioBuffer,
    pub(crate) output_node: NodeId,
    pub(crate) nodes: Vec<NodeId>,
    pub(crate) edges: Vec<(NodeId, NodeId)>,
    pub(crate) device_params: Vec<DeviceParams>,
    pub(crate) sidechains: Vec<SidechainBinding> // sidechain bindings collected from this cluster's audio fx
}

/// One device's bound parameters: enough to re-observe and re-push them on a runtime automation change. The
/// `handles` are clones the engine reads for the build / edit push (sharing the node's `Rc<Cell>`s, so the
/// `last`-value diff stays consistent with the clock pull); `field_subs` + `collections` are the graph
/// observations to drop on teardown / re-bind.
pub(crate) struct DeviceParams {
    device_uuid: Uuid,
    reg: DeviceReg,
    state_ptr: u32,
    sink: ParamNode,       // the node, to re-set params on a re-bind
    paths: Vec<FieldPath>, // the parameter field-paths the device declared in `init`
    handles: Vec<ParamHandle>,
    field_subs: Vec<SubscriptionId>,
    collections: Vec<ValueCollection>,
    observe_subs: Vec<SubscriptionId>, // the device's PLAIN field observations (`observe_field`), dropped on teardown
    sidechain_paths: Vec<Vec<u16>> // the audio effect's declared sidechain pointer paths (`bind_sidechain`), in order
}

/// A persistent sidechain binding kept by the owning unit: an audio effect that declared sidechain ports, the
/// node it became, and one `SidechainPort` per declared pointer. Unlike a one-shot resolve, this survives so
/// the resolution pass can RE-resolve every reconcile that did work — handling re-pointing, detach, a source
/// unit (re)building, and build order, all by diffing each port's current target against `resolved`.
pub(crate) struct SidechainBinding {
    pub(crate) effect: Rc<RefCell<PluginAudioEffect>>,
    pub(crate) node_id: NodeId,
    pub(crate) device_uuid: Uuid,
    pub(crate) ports: Vec<SidechainPort>
}

/// One declared sidechain port: its id (2+), the device-relative pointer path to follow, the source node it
/// is currently wired to (`None` = unresolved, kept so the resolve pass can diff + tear down the old edge),
/// and a TARGETED `This` monitor on the device's sidechain pointer field so a re-point / detach enqueues the
/// owning unit (no all-updates listener).
pub(crate) struct SidechainPort {
    pub(crate) port_id: u32,
    pub(crate) path: Vec<u16>,
    pub(crate) resolved: Option<NodeId>,
    pub(crate) pointer_sub: SubscriptionId
}

/// Where bound parameters are pushed: an audio node (instrument / audio-fx, mutated through its
/// `Rc<RefCell>`) or a MIDI-fx (shared behind a bare `Rc`, mutated through its interior cells). Both expose
/// "replace this device's params + clock-armed state"; this dispatches to whichever it holds.
enum ParamNode {
    Audio(Rc<RefCell<dyn ParamSink>>),
    Midi(Rc<PluginMidiEffect>)
}

impl ParamNode {
    fn set_params(&self, params: Vec<ParamHandle>, clock_armed: bool) {
        match self {
            ParamNode::Audio(node) => node.borrow_mut().set_params(params, clock_armed),
            ParamNode::Midi(effect) => effect.set_params(params, clock_armed)
        }
    }
}

/// A live audio-unit BINDING. The RootBox `audio-units` membership drives create / destroy. Beneath it:
/// the track -> region cascade feeds the per-track `track_sets` the sequencer reads; and three
/// `IndexedCollection`s observe the unit's device hosts — `input` (the instrument, host 22), `midi` (host
/// 21), `audio` (host 23) — each ordered by the device `index`. The wired processor cluster is rebuilt
/// (from the device table + the sorted chains) ONLY when one of those three reports `dirty`, so a unit's
/// wiring stays stable until the user edits its scope. Teardown drops the cluster, the cascade, and the
/// chain subscriptions.
pub(crate) struct AudioUnitBinding {
    unit: Uuid,
    track_sets: SharedTrackSets,
    collections: CollectionCache,
    tracks: Vec<TrackBinding>,
    track_changes: Rc<RefCell<Members>>,
    track_sub: SubscriptionId,
    strip_params: Rc<StripParams>,        // the unit's volume / panning / mute, kept in sync with its box
    strip_subs: Vec<SubscriptionId>,      // the volume / panning / mute field subscriptions
    input: IndexedCollection,
    midi: IndexedCollection,
    audio: IndexedCollection,
    // The wired processor graph: a leaf unit's persistent per-member chain, or a composite unit's bundle.
    // `None` until the first reconcile (or a unit with no resolvable instrument). The instrument's composite
    // cascade, the sidechain bindings, and the bound parameters all live INSIDE this now (per member for a
    // leaf, in the bundle for a composite), so they survive a chain edit exactly as far as the wiring does.
    wired: Option<Wired>,
    // Set by a parameter's TARGETED automation subscriptions (see `observe_params` / `automation_invalidate`)
    // when a Value track attaches / detaches or its data changes; `reconcile_one` then re-binds the unit's
    // curves (no rewire) and clears it.
    automation_dirty: Rc<Cell<bool>>,
    // Set by a device's `enabled` monitor: the chain membership did not change, but the unit must RE-WIRE
    // (skip / include the toggled effect). `reconcile_one` treats it like a chain-dirty so reconcile_leaf runs
    // its edge-only re-wire (survivors reused — no param push, no reset).
    wiring_dirty: Rc<Cell<bool>>,
    // Enqueues THIS unit for a targeted reconcile when any of its scope subscriptions (chains, tracks,
    // regions, automation, composite, sidechain pointers) fire — so a related edit rewires one unit.
    mark: DirtyMark
}

impl Engine {
    /// Start observing the RootBox `audio-units` membership: each connected `AudioUnitBox` becomes a unit
    /// binding, created / destroyed LIVE as the box graph changes (the reactive replacement for a one-shot
    /// build). The membership observer only records into `unit_changes`; the actual graph mutation happens
    /// in `reconcile_units` (catch-up here, and after every transaction). The master bus must already exist
    /// (created by the engine before this is called), since `reconcile_units` wires units into it.
    pub(crate) fn observe_audio_units(&mut self) {
        // RootBox.audio-units is field key 20; an AudioUnitBox connects via its `collection` pointer, so the
        // hub source's uuid IS the audio unit. We do not order the units (order is not audible).
        if let Some(root) = self.graph.find_by_name("RootBox") {
            let changes = self.unit_changes.clone();
            self.graph.subscribe_pointer_hub(Address::of(root.uuid, vec![ROOT_AUDIO_UNITS_KEY]), Box::new(move |_graph, event| {
                match event {
                    HubEvent::Added(source) => changes.borrow_mut().added.push(source.uuid),
                    HubEvent::Removed(source) => changes.borrow_mut().removed.push(source.uuid)
                }
            }));
        }
        self.reconcile_units();
    }

    /// THE output audio unit's uuid: the `AudioUnitBox` whose `type` (field 1) is `"output"`. It is a fixed
    /// singleton (there is exactly one, and it never changes), so it is found once and wired statically.
    fn output_unit_uuid(&self) -> Option<Uuid> {
        self.graph.find_all_by_name("AudioUnitBox").iter()
            .find(|unit| self.graph.field_value(&Address::of(unit.uuid, vec![1])).and_then(|value| value.as_str()) == Some("output"))
            .map(|unit| unit.uuid)
    }

    fn is_output_unit(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![1])).and_then(|value| value.as_str()) == Some("output")
    }

    /// Wire THE output unit's channel strip as the engine's final master, fed by the static summing bus
    /// (`master_output`, the engine's `master` bus that every instrument unit sums into). The strip applies
    /// the output unit's volume / panning / mute (bound to its box) and its output is what `render` reads.
    /// Built ONCE at bind — the output unit and its bus are fixed singletons, never reactive. Returns the
    /// buffer `render` should read: the strip's output, or `master_output` directly if there is no output unit.
    pub(crate) fn output_strip(&mut self, master_output: SharedAudioBuffer) -> SharedAudioBuffer {
        let uuid = match self.output_unit_uuid() {
            Some(uuid) => uuid,
            None => return master_output
        };
        let params = Rc::new(StripParams::new());
        let volume = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_VOLUME_KEY]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_PANNING_KEY]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_MUTE_KEY]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // THE output unit's own audio-effect chain (e.g. a master Tidal), wired between the summing bus and
        // the master strip: bus -> fx0 -> ... -> strip, ordered by device index. Each device binds its
        // parameters like an instrument unit's, and the initial values are pushed below. Built once at bind
        // (the output unit is a fixed singleton), so the chain is not reactive yet.
        let mut source = master_output;
        let mut source_id = self.master_id;
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_AUDIO_KEY]), EFFECT_INDEX_KEY);
        let mut device_params: Vec<DeviceParams> = Vec::new();
        // THE output unit is a fixed singleton built once at bind, not reconciled, so its parameters need no
        // runtime re-bind: a no-op invalidate (its static values are pushed by `refresh_params` below).
        let noop: Rc<dyn Fn()> = Rc::new(|| {});
        for device_uuid in audio.sorted() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_AUDIO_EFFECT => device,
                _ => continue
            };
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            let node_state = node.borrow().state_ptr();
            let node_sink: Rc<RefCell<dyn ParamSink>> = node.clone();
            device_params.push(self.bind_device(device_uuid, device, node_state, ParamNode::Audio(node_sink), &noop));
            node.borrow_mut().set_audio_source(source);
            source = node.borrow().audio_output();
            let node_id = self.context.register_processor(node);
            self.context.register_edge(source_id, node_id);
            source_id = node_id;
        }
        let position = self.transport.position();
        for params in &device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
        self.output_audio = Some(audio);
        self.output_device_params = device_params;
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(params, self.sample_rate)));
        strip.borrow_mut().set_audio_source(source);
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip);
        self.context.register_edge(source_id, strip_id); // the (effected) summing bus feeds the master strip
        strip_output
    }

    /// Apply a transaction's recorded changes: tear down / build audio units whose MEMBERSHIP changed, then
    /// reconcile ONLY the units a related edit touched (each subscription enqueues its own unit into
    /// `dirty_units` via `DirtyMark`, mirroring TS's per-unit `invalidateWiring`). Called on bind (catch-up)
    /// and after every transaction; a transaction that touched no unit drains nothing, so it is a true no-op
    /// instead of a sweep over every unit and track.
    pub(crate) fn reconcile_units(&mut self) {
        if self.master.is_none() {
            return;
        }
        let changes = core::mem::take(&mut *self.unit_changes.borrow_mut());
        // A membership change is structural: a unit appearing / disappearing can resolve or strand a sidechain
        // pointing at it, so the resolve pass must run even if no unit was otherwise enqueued.
        let structural = !changes.added.is_empty() || !changes.removed.is_empty();
        for uuid in changes.removed {
            if let Some(index) = self.audio_units.iter().position(|binding| binding.unit == uuid) {
                let binding = self.audio_units.remove(index);
                self.teardown_unit(binding);
            }
        }
        for uuid in changes.added {
            if self.audio_units.iter().any(|binding| binding.unit == uuid) {
                continue;
            }
            if self.is_output_unit(uuid) {
                continue; // THE output unit is a fixed singleton, wired statically at bind (see `output_strip`)
            }
            let binding = self.build_unit(uuid);
            binding.mark.mark(); // a new unit reconciles itself once (wires its instrument even with no tracks)
            self.audio_units.push(binding);
        }
        // Reconcile only the enqueued units. Take the bindings out so each unit's work can borrow `&mut self`
        // (graph, context, master) without aliasing `self.audio_units`. A rewire's composite catch-up cannot
        // re-enqueue (its signal is wired after the catch-up is consumed), so one drain suffices.
        let dirty = core::mem::take(&mut *self.dirty_units.borrow_mut());
        let did_work = structural || !dirty.is_empty();
        if !dirty.is_empty() {
            let mut units = core::mem::take(&mut self.audio_units);
            for uuid in dirty {
                if let Some(unit) = units.iter_mut().find(|binding| binding.unit == uuid) {
                    self.reconcile_one(unit);
                }
            }
            self.audio_units = units;
        }
        // Every unit's output is now (re)registered, so re-resolve all sidechains — but ONLY if this reconcile
        // did work (a membership change or an enqueued unit, e.g. a sidechain pointer re-point marks its unit).
        // An idle transaction skips it entirely. The pass itself is diff-based, so it no-ops per unchanged port.
        if did_work {
            self.resolve_sidechains();
        }
    }

    /// Reconcile ONE unit (it was enqueued because a related edit touched its scope): cascade its tracks ->
    /// regions, then re-wire if a device chain or its composite changed (`|` so all dirty flags are consumed),
    /// else re-bind its automation curves if those attached / detached. A full rewire re-gathers automation,
    /// so it also clears that flag.
    fn reconcile_one(&mut self, unit: &mut AudioUnitBinding) {
        reconcile_tracks(&mut self.graph, unit);
        // A REAL automation change (a Value track attach / detach / curve edit on an EXISTING parameter) sets
        // this flag BEFORE this reconcile runs. A joiner's initial parameter catch-up ALSO sets it during the
        // chain reconcile below — but that is spurious (the joiner is bound + refreshed at build), so it must
        // NOT trigger a broad re-bind that would re-push every SURVIVING plugin's parameters (which would, e.g.,
        // glide a delay's offset). So capture it first and only re-bind for a genuine pre-existing change.
        let automation_changed = unit.automation_dirty.get();
        // `wiring_dirty` (a device `enabled` toggle) re-wires the chain edge-only without a membership change.
        let unit_dirty = unit.input.take_dirty() | unit.midi.take_dirty() | unit.audio.take_dirty() | unit.wiring_dirty.replace(false);
        if unit_dirty {
            // The unit's own chain changed (instrument swapped, or a unit-level fx joined / left): reconcile the
            // whole chain (a composite instrument is rebuilt; a leaf reconciles per member). Survivors untouched.
            self.reconcile_chain(unit);
        } else if matches!(&unit.wired, Some(Wired::Composite(_))) {
            // The instrument is an UNCHANGED composite; reconcile its children per member (a slot add / remove /
            // reorder, or a child's own fx edit). A no-op when nothing changed.
            let signal = unit.mark.signal();
            let invalidate = automation_invalidate(unit);
            let track_sets = unit.track_sets.clone();
            if let Some(Wired::Composite(composite)) = &mut unit.wired {
                self.reconcile_composite_children(&mut composite.binding, &track_sets, &signal, &invalidate);
            }
        }
        if automation_changed {
            self.rebind_automation(unit);
        }
        unit.automation_dirty.set(false); // consume the joiner catch-up flags + the handled real change
    }

    /// Re-resolve EVERY unit's sidechain bindings against the current graph, diff-based so it is a no-op when
    /// nothing moved. For each declared port: follow the device pointer to its target box, look that box's
    /// output up in the registry, and if the source NODE differs from what is wired, swap the producer ->
    /// consumer edge. Then, if any port changed, rebuild the effect's sidechain set from the currently-resolved
    /// ports. An unresolved port (pointer unset / target not built / target gone) clears its edge and is absent
    /// from the rebuilt set, so the device falls back to MAIN. This one pass handles re-pointing, detach, a
    /// source unit (re)building with a new buffer, and load build order uniformly. Run only when a reconcile
    /// did work (a membership change or an enqueued unit), so an idle transaction does nothing here.
    fn resolve_sidechains(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            match &mut unit.wired {
                Some(Wired::Leaf(chain)) => {
                    for member in &mut chain.audio {
                        if let Some(binding) = &mut member.sidechain {
                            self.resolve_one_sidechain(binding);
                        }
                    }
                }
                Some(Wired::Composite(composite)) => {
                    composite.binding.for_each_sidechain(&mut |binding| self.resolve_one_sidechain(binding));
                }
                None => {}
            }
        }
        self.audio_units = units;
    }

    /// Resolve ONE sidechain binding against the current graph: for each port follow the device pointer to its
    /// target's output, swap the producer -> consumer edge if the source node changed, and (if any port moved)
    /// push the device its current sidechain sources. See `resolve_sidechains` for the why.
    fn resolve_one_sidechain(&mut self, binding: &mut SidechainBinding) {
        let mut changed = false;
        let mut sources: Vec<(u32, SharedAudioBuffer)> = Vec::new();
        for port in &mut binding.ports {
            let target = self.graph.target_of(&Address::of(binding.device_uuid, port.path.clone())).cloned();
            let resolution = target.and_then(|target| self.output_registry.resolve(&Address::of(target.uuid, vec![]))
                .map(|output| (output.processor, output.buffer.clone())));
            let source_node = resolution.as_ref().map(|(node, _)| *node);
            if source_node != port.resolved {
                if let Some(old) = port.resolved {
                    self.context.remove_edge(old, binding.node_id);
                }
                if let Some(new) = source_node {
                    self.context.register_edge(new, binding.node_id);
                }
                port.resolved = source_node;
                changed = true;
            }
            if let Some((_, buffer)) = resolution {
                sources.push((port.port_id, buffer));
            }
        }
        if changed {
            binding.effect.borrow_mut().set_sidechains(&sources);
        }
    }

    /// Remove a unit entirely: drop its wired cluster (edges, nodes, bus source), unsubscribe its tracks
    /// membership + track cascade, and terminate its three device-chain collections.
    fn teardown_unit(&mut self, mut binding: AudioUnitBinding) {
        if let Some(wired) = binding.wired.take() {
            self.teardown_wired_value(wired);
        }
        self.graph.unsubscribe(binding.track_sub);
        for sub in &binding.strip_subs {
            self.graph.unsubscribe(*sub);
        }
        for track in binding.tracks {
            teardown_track(&mut self.graph, &binding.track_sets, &mut binding.collections, track);
        }
        binding.collections.terminate_all(&mut self.graph); // defensive; the tracks released everything
        binding.input.terminate(&mut self.graph);
        binding.midi.terminate(&mut self.graph);
        binding.audio.terminate(&mut self.graph);
    }

    /// Drop a unit's whole wired graph (full teardown, the analog of TS `#disconnector.terminate` plus
    /// terminating every `#effects` entry): unwire from the master, remove its edges + nodes, and terminate
    /// each member's params + sidechain monitors. Used when a unit is removed, or its instrument changes kind.
    fn teardown_unit_wired(&mut self, unit: &mut AudioUnitBinding) {
        if let Some(wired) = unit.wired.take() {
            self.teardown_wired_value(wired);
        }
    }

    fn teardown_wired_value(&mut self, wired: Wired) {
        match wired {
            Wired::Leaf(chain) => {
                if let Some(master) = &self.master {
                    master.borrow_mut().remove_audio_source(&chain.strip_output);
                }
                for (source, target) in &chain.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(chain.strip_id);
                self.terminate_member(chain.instrument);
                for member in chain.midi {
                    self.terminate_member(member);
                }
                for member in chain.audio {
                    self.terminate_member(member);
                }
            }
            Wired::Composite(composite) => {
                if let Some(master) = &self.master {
                    master.borrow_mut().remove_audio_source(&composite.strip_output);
                }
                for (source, target) in &composite.tail_edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(composite.strip_id);
                self.teardown_composite(composite.binding);
            }
        }
    }

    /// Terminate ONE leaf chain member (a leaver, or a full teardown): remove its processor node (a midi-fx
    /// has none), drop its sidechain ports' pointer monitors, and unsubscribe its parameter observations.
    fn terminate_member(&mut self, member: Member) {
        if let Some(node_id) = member.node_id {
            self.context.remove_processor(node_id);
        }
        if let Some(sidechain) = member.sidechain {
            for port in sidechain.ports {
                self.graph.unsubscribe(port.pointer_sub);
            }
        }
        self.graph.unsubscribe(member.enabled_sub);
        self.teardown_device_params(vec![member.params]);
    }

    /// Build a unit binding: its per-track region collections list (`track_sets`, shared with the
    /// sequencer), the track-membership subscription (key 20) the cascade fills, and the three device-chain
    /// collections — `input` (host 22), `midi` (host 21), `audio` (host 23), each ordered by the device
    /// `index` (field 2). No processor nodes yet; the first `reconcile` rewires it (the collections are dirty
    /// from catch-up). No per-device-type logic: the device table (`device_for_type`) maps each box to its plugin.
    fn build_unit(&mut self, uuid: Uuid) -> AudioUnitBinding {
        let mark = DirtyMark {units: self.dirty_units.clone(), unit: uuid};
        let track_sets: SharedTrackSets = Rc::new(RefCell::new(Vec::new()));
        let track_changes = Rc::new(RefCell::new(Members::default()));
        let recorder = track_changes.clone();
        let track_mark = mark.clone();
        let track_sub = self.graph.subscribe_pointer_hub(Address::of(uuid, vec![UNIT_TRACKS_KEY]), Box::new(move |_graph, event| {
            match event {
                HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
                HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
            }
            track_mark.mark();
        }));
        // The instrument `input` host holds ONE instrument, which has no `index` field (only effects do). So it
        // is never ordered: key `0` is a non-field, read back as 0 for every member, and the collection is used
        // only for membership + `.first()`. The midi (21) and audio (23) chains ARE effects, ordered by index.
        let input = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_INPUT_KEY]), 0);
        let midi = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_MIDI_KEY]), EFFECT_INDEX_KEY);
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_AUDIO_KEY]), EFFECT_INDEX_KEY);
        // A chain edit (add / remove / reorder a device) enqueues this unit for a targeted reconcile. Wired
        // after `observe` so the catch-up members do not fire it; the new unit enqueues itself once below.
        input.set_on_dirty(mark.signal());
        midi.set_on_dirty(mark.signal());
        audio.set_on_dirty(mark.signal());
        // The channel strip's parameters, kept in sync with the unit's box: volume (12, dB), panning (13),
        // mute (14). Reactive but no rewire needed — the strip reads these Cells each block.
        let strip_params = Rc::new(StripParams::new());
        let volume = strip_params.clone();
        let volume_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_VOLUME_KEY]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = strip_params.clone();
        let panning_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_PANNING_KEY]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = strip_params.clone();
        let mute_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_MUTE_KEY]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // Automation reactivity is per-parameter and TARGETED (see `observe_params`): each parameter's field
        // value, its automation pointer-hub, and its track's region hub fire `automation_invalidate`, which
        // sets this flag + enqueues the unit, so `reconcile_one` re-binds the unit's curves (no rewire). No
        // per-unit all-updates observer.
        let automation_dirty = Rc::new(Cell::new(false));
        let wiring_dirty = Rc::new(Cell::new(false));
        AudioUnitBinding {
            unit: uuid, track_sets, collections: CollectionCache::default(), tracks: Vec::new(),
            track_changes, track_sub, strip_params, strip_subs: vec![volume_sub, panning_sub, mute_sub],
            input, midi, audio, wired: None, automation_dirty, wiring_dirty, mark
        }
    }

    /// The closure each device's `enabled` monitor fires: mark the unit for a re-wire and enqueue it. A
    /// re-wire reconcile reuses every member (edge-only — no param push, no reset), so a bypass costs nothing
    /// but the connection.
    fn rewire_signal(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
        let flag = unit.wiring_dirty.clone();
        let mark = unit.mark.clone();
        Rc::new(move || {
            flag.set(true);
            mark.mark();
        })
    }

    /// Reconcile a unit's processor graph to its current chains. Resolve the instrument; dispatch to the
    /// per-member LEAF path (instrument + midi-fx + audio-fx) or the COMPOSITE path. A unit with no resolvable
    /// instrument is left silent (its wiring fully torn down). The only per-device knowledge is the
    /// box-type -> plugin table.
    fn reconcile_chain(&mut self, unit: &mut AudioUnitBinding) {
        let instrument_uuid = match unit.input.sorted().first().copied() {
            Some(uuid) => uuid,
            None => return self.teardown_unit_wired(unit) // no instrument: silent until its `input` box appears
        };
        let box_name = match self.graph.find_box(&instrument_uuid) {
            Some(device_box) => device_box.name.clone(),
            None => return self.teardown_unit_wired(unit)
        };
        // Enqueues this unit when a chain / child / sidechain pointer of its scope changes, plus the parameter
        // `invalidate` (which also sets `automation_dirty`). Both threaded through the whole build.
        let signal = unit.mark.signal();
        let invalidate = automation_invalidate(unit);
        let rewire = Self::rewire_signal(unit); // a device `enabled` toggle re-wires the chain edge-only
        if let Some(spec) = self.composite_for_type(&box_name) {
            self.reconcile_composite(unit, instrument_uuid, spec, &signal, &invalidate);
        } else {
            match self.device_for_type(&box_name) {
                Some(device) if device.kind == DEVICE_KIND_INSTRUMENT =>
                    self.reconcile_leaf(unit, instrument_uuid, device, &signal, &invalidate, &rewire),
                _ => self.teardown_unit_wired(unit) // not a buildable instrument: silent
            }
        }
    }

    /// The COMPOSITE-instrument path (e.g. Playfield): tear down the old wiring and rebuild the child cascade
    /// wholesale (per-child lifecycle is internal to the `composite` module). The composite's own midi / audio
    /// unit chains are not wrapped around it yet. Mapping-agnostic — `spec` names the slot collection.
    fn reconcile_composite(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, spec: CompositeSpec,
                           signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        self.teardown_unit_wired(unit);
        let track_sets = unit.track_sets.clone();
        let binding = self.build_composite(&track_sets, instrument_uuid, &spec, signal, invalidate);
        // The unit's tail: the composite's sum bus -> channel strip -> master. The strip + these edges persist
        // across later per-child reconciles (the sum bus is stable).
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(binding.sum_buffer.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip);
        let mut tail_edges = Vec::new();
        self.context.register_edge(binding.sum_id, strip_id);
        tail_edges.push((binding.sum_id, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        let master = self.master.as_ref().unwrap();
        master.borrow_mut().add_audio_source(strip_output.clone());
        self.context.register_edge(strip_id, self.master_id);
        tail_edges.push((strip_id, self.master_id));
        // Each child's parameters are pushed as it is built (a joiner), inside `build_one_child`; no blanket
        // re-push here, so a per-child reconcile never touches an existing slot's parameters.
        unit.wired = Some(Wired::Composite(CompositeWired {binding, strip_id, strip_output, tail_edges}));
    }

    /// The LEAF-instrument per-member path, mirroring TS `AudioDeviceChain`: keep the existing device
    /// processors, create only the joiners, terminate only the leavers, then re-wire EDGES ONLY. A processor
    /// that survives keeps its instance (and so its DSP state — voices, delay tails, filter history); only
    /// joiners are built + bound (re-binding re-runs the device `init`, which resets DSP, so survivors must be
    /// left untouched). The channel strip persists across reconciles too.
    fn reconcile_leaf(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, instrument_device: DeviceReg,
                      signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
        // Pool the previous leaf members so survivors can be reused; remove the previous edges (the
        // `#disconnector` analog — edge-only teardown, NODES KEPT). A stale composite / none is fully removed.
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let mut strip_keep: Option<(Rc<RefCell<ChannelStripProcessor>>, NodeId, SharedAudioBuffer)> = None;
        let mut sequencer_keep: Option<(Uuid, SharedNoteEventSource)> = None;
        match unit.wired.take() {
            Some(Wired::Leaf(chain)) => {
                for (source, target) in &chain.edges {
                    self.context.remove_edge(*source, *target);
                }
                if let Some(master) = &self.master {
                    master.borrow_mut().remove_audio_source(&chain.strip_output);
                }
                sequencer_keep = Some((chain.instrument.uuid, chain.sequencer));
                pool.insert(chain.instrument.uuid, chain.instrument);
                for member in chain.midi {
                    pool.insert(member.uuid, member);
                }
                for member in chain.audio {
                    pool.insert(member.uuid, member);
                }
                strip_keep = Some((chain.strip, chain.strip_id, chain.strip_output));
            }
            Some(other) => self.teardown_wired_value(other),
            None => {}
        }
        // Build the desired chain, reusing survivors from the pool (joiners are created + bound).
        let instrument = self.take_or_build_instrument(&mut pool, instrument_uuid, instrument_device, invalidate, rewire);
        let mut midi_members: Vec<Member> = Vec::new();
        for uuid in unit.midi.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_MIDI_EFFECT {
                    midi_members.push(self.take_or_build_midi(&mut pool, uuid, device, invalidate, rewire));
                }
            }
        }
        let mut audio_members: Vec<Member> = Vec::new();
        for uuid in unit.audio.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_AUDIO_EFFECT {
                    audio_members.push(self.take_or_build_audio(&mut pool, uuid, device, signal, invalidate, rewire));
                }
            }
        }
        // Whatever remains pooled left the chain (a leaver): terminate it (node + sidechain monitors + params).
        for (_, member) in core::mem::take(&mut pool) {
            self.terminate_member(member);
        }
        // Reuse the instrument's note source if the instrument SURVIVED (it holds notes retained across blocks;
        // recreating it mid-play would drop them — stuck / re-triggered notes). Build a fresh one only when the
        // instrument itself is a joiner. Then fold the midi-fx PULL chain over it (reused midi effects keep
        // their state; only the pull wrappers are rebuilt).
        let sequencer: SharedNoteEventSource = match sequencer_keep {
            Some((uuid, kept)) if uuid == instrument_uuid => kept,
            _ => Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: unit.track_sets.clone()}))))
        };
        let mut pull = PullLink::Source(sequencer.clone());
        for member in &midi_members {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled midi-fx is bypassed (left out of the pull chain); its state is untouched
            }
            if let ProcHandle::Midi(effect) = &member.proc {
                pull = PullLink::MidiFx {effect: effect.clone(), upstream: Rc::new(pull)};
            }
        }
        if let ProcHandle::Instrument(processor) = &instrument.proc {
            processor.borrow_mut().set_pull_chain(pull);
        }
        // Edge-only re-wire: instrument -> fx0 -> ... -> strip -> master, in chain order.
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output = instrument.output.clone().unwrap();
        let mut output_node = instrument.node_id.unwrap();
        for member in &audio_members {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled audio-fx is BYPASSED: not wired into the signal path; processor untouched
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.unwrap();
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            output = member.output.clone().unwrap();
            output_node = node_id;
        }
        // The channel strip terminates the chain; reuse it across reconciles (it carries no DSP state, just the
        // shared volume / panning / mute), re-pointing its source at the new tail.
        let (strip, strip_id, strip_output) = match strip_keep {
            Some(existing) => existing,
            None => {
                let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), self.sample_rate)));
                let strip_output = strip.borrow().audio_output();
                let strip_id = self.context.register_processor(strip.clone());
                (strip, strip_id, strip_output)
            }
        };
        strip.borrow_mut().set_audio_source(output);
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        let master = self.master.as_ref().unwrap();
        master.borrow_mut().add_audio_source(strip_output.clone());
        self.context.register_edge(strip_id, self.master_id);
        edges.push((strip_id, self.master_id));
        // Parameters are pushed ONLY to JOINERS (at build, in `take_or_build_*`). Survivors are NOT touched — a
        // reorder / add / remove must leave every existing plugin's parameters exactly as they are (re-pushing
        // would, e.g., glide a delay's offset). A real automation change re-binds via `rebind_automation`.
        unit.wired = Some(Wired::Leaf(LeafChain {
            instrument, sequencer, midi: midi_members, audio: audio_members, strip, strip_id, strip_output, edges
        }));
    }

    /// Whether a device box is `enabled` (default true): a disabled audio / midi effect is bypassed — skipped
    /// in the chain wiring, its processor + params + DSP state left fully intact.
    fn device_enabled(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![DEVICE_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
    }

    /// A TARGETED `This` monitor on a device's `enabled` field: a toggle fires `rewire` (mark + enqueue the
    /// unit), so `reconcile_leaf` re-wires the chain edge-only, skipping / including the toggled effect.
    fn subscribe_enabled(&mut self, uuid: Uuid, rewire: &Rc<dyn Fn()>) -> SubscriptionId {
        let rewire = rewire.clone();
        self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, vec![DEVICE_ENABLED_KEY]),
            Box::new(move |_graph, _update| rewire()))
    }

    /// Reuse the pooled instrument processor (a survivor: its voices live on) or build + bind a fresh one (a
    /// joiner). A pooled entry of a different role under this uuid is terminated and rebuilt.
    fn take_or_build_instrument(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                                invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Instrument(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, device)));
        let state_ptr = instrument.borrow().state_ptr();
        let sink: Rc<RefCell<dyn ParamSink>> = instrument.clone();
        let params = self.bind_device(uuid, device, state_ptr, ParamNode::Audio(sink), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        let output = instrument.borrow().audio_output();
        let node_id = self.context.register_processor(instrument.clone());
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Instrument(instrument), node_id: Some(node_id), output: Some(output), params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled midi-fx (a survivor) or build + bind a fresh one (a joiner). A midi-fx has no audio
    /// node; it is folded into the instrument's pull chain.
    fn take_or_build_midi(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                          invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Midi(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let effect = Rc::new(PluginMidiEffect::new(device));
        let params = self.bind_device(uuid, device, effect.state_ptr(), ParamNode::Midi(effect.clone()), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Midi(effect), node_id: None, output: None, params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled audio-fx (a survivor: its delay tail / filter history live on) or build + bind a fresh
    /// one (a joiner), creating its sidechain ports + their targeted pointer monitors. The resolve pass wires
    /// the sidechain edges.
    fn take_or_build_audio(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                           signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Audio(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
        let state_ptr = node.borrow().state_ptr();
        let sink: Rc<RefCell<dyn ParamSink>> = node.clone();
        let params = self.bind_device(uuid, device, state_ptr, ParamNode::Audio(sink), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        let output = node.borrow().audio_output();
        let node_id = self.context.register_processor(node.clone());
        let sidechain = if params.sidechain_paths.is_empty() {
            None
        } else {
            let mut ports = Vec::new();
            for (index, path) in params.sidechain_paths.iter().cloned().enumerate() {
                let port_signal = signal.clone();
                let pointer_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, path.clone()),
                    Box::new(move |_graph, _update| port_signal()));
                ports.push(SidechainPort {port_id: index as u32 + 2, path, resolved: None, pointer_sub});
            }
            Some(SidechainBinding {effect: node.clone(), node_id, device_uuid: uuid, ports})
        };
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Audio(node), node_id: Some(node_id), output: Some(output), params, sidechain, enabled_sub}
    }

    /// Build one processor cluster: an instrument plus its midi-fx pull chain (folded onto `source` in index
    /// order, so the instrument pulls the highest-index fx down to the source) and its audio-fx chain
    /// (instrument -> fx0 -> fx1 -> ...), wired into the global graph. Returns the chain's final output buffer
    /// and last node so the caller appends its own tail (a unit appends the channel strip then master, a
    /// composite child appends the per-child sum), plus the node / edge / param bookkeeping. The only
    /// per-device knowledge is the box-type -> plugin table, so any cluster host reuses this verbatim.
    pub(crate) fn build_cluster(&mut self, source: PullLink, instrument_uuid: Uuid, instrument_device: DeviceReg,
                     midi: &[Uuid], audio: &[Uuid], signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) -> BuiltCluster {
        let mut device_params: Vec<DeviceParams> = Vec::new();
        // Each midi-fx binds its parameters too, so a midi-fx parameter is automatable like an audio device's.
        let mut chain = source;
        for device_uuid in midi.iter().copied() {
            let device = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            match device {
                Some(device) if device.kind == DEVICE_KIND_MIDI_EFFECT => {
                    let effect = Rc::new(PluginMidiEffect::new(device));
                    device_params.push(self.bind_device(device_uuid, device, effect.state_ptr(), ParamNode::Midi(effect.clone()), invalidate));
                    chain = PullLink::MidiFx {effect, upstream: Rc::new(chain)};
                }
                _ => {}
            }
        }
        let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, instrument_device)));
        let instrument_state = instrument.borrow().state_ptr();
        let instrument_sink: Rc<RefCell<dyn ParamSink>> = instrument.clone();
        device_params.push(self.bind_device(instrument_uuid, instrument_device, instrument_state, ParamNode::Audio(instrument_sink), invalidate));
        instrument.borrow_mut().set_pull_chain(chain);
        let mut output = instrument.borrow().audio_output();
        let instrument_id = self.context.register_processor(instrument);
        let mut nodes = vec![instrument_id];
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut sidechains: Vec<SidechainBinding> = Vec::new();
        let mut output_node = instrument_id;
        // The audio-fx chain in index order: instrument -> fx0 -> fx1 -> ... Each reads the previous output.
        for device_uuid in audio.iter().copied() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_AUDIO_EFFECT => device,
                _ => continue
            };
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            let node_state = node.borrow().state_ptr();
            let node_sink: Rc<RefCell<dyn ParamSink>> = node.clone();
            let params = self.bind_device(device_uuid, device, node_state, ParamNode::Audio(node_sink), invalidate);
            let sidechain_paths = params.sidechain_paths.clone();
            device_params.push(params);
            node.borrow_mut().set_audio_source(output);
            output = node.borrow().audio_output();
            let node_id = self.context.register_processor(node.clone());
            // Keep this effect's declared sidechain ports as a persistent binding (resolved by the post-build
            // pass, re-resolved on later edits). Each port gets a TARGETED `This` monitor on its pointer
            // field, so a re-point / detach enqueues the unit. Port ids start at 2 (after MAIN_INPUT).
            if !sidechain_paths.is_empty() {
                let mut ports = Vec::new();
                for (index, path) in sidechain_paths.into_iter().enumerate() {
                    let port_signal = signal.clone();
                    let pointer_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                        Box::new(move |_graph, _update| port_signal()));
                    ports.push(SidechainPort {port_id: index as u32 + 2, path, resolved: None, pointer_sub});
                }
                sidechains.push(SidechainBinding {effect: node, node_id, device_uuid, ports});
            }
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            nodes.push(node_id);
            output_node = node_id;
        }
        BuiltCluster {output, output_node, nodes, edges, device_params, sidechains}
    }

    /// Bind one device's parameters: call its `init` (which records its parameter field-paths via
    /// `host_bind_parameter`), observe each path's field value + automation track, hand the node its
    /// parameter set, and return the bookkeeping for teardown / re-bind.
    fn bind_device(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, sink: ParamNode, invalidate: &Rc<dyn Fn()>) -> DeviceParams {
        let paths = bind_paths(reg, state_ptr, self.sample_rate);
        let sample_paths = core::mem::take(unsafe { SAMPLE_OBS.get() }); // recorded by host_observe_sample during init
        let field_paths = core::mem::take(unsafe { FIELD_OBS.get() }); // recorded by host_observe_field during init
        let sidechain_paths = core::mem::take(unsafe { SIDECHAIN_BIND.get() }); // recorded by host_bind_sidechain during init
        let (handles, field_subs, collections, armed) = self.observe_params(device_uuid, &paths, invalidate);
        sink.set_params(handles.clone(), armed);
        // The device's plain-field and sample observations both unsubscribe the same way, so keep one list.
        let mut observe_subs = self.observe_fields(device_uuid, reg, state_ptr, &field_paths);
        observe_subs.extend(self.observe_samples(device_uuid, reg, state_ptr, &sample_paths));
        DeviceParams {device_uuid, reg, state_ptr, sink, paths, handles, field_subs, collections, observe_subs, sidechain_paths}
    }

    /// Wire each PLAIN field a device asked to observe (`observe_field`): `catchup_and_subscribe` the field on
    /// the device's box and deliver its value through the device's `field_changed` export, by the id (the
    /// observation's index) the device got back. The callback runs on catch-up and on edits, only inside a
    /// transaction, never during render, so calling the device is safe. Returns the subscriptions for teardown.
    fn observe_fields(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let field_changed_index = reg.field_changed_index;
            let sub = self.graph.catchup_and_subscribe(Address::of(device_uuid, path.clone()), move |value| {
                // Encode the field's typed value onto the wire `(kind, bits, len)`: numeric bits, or a string's
                // pointer + length into the shared memory (valid for the synchronous call).
                if let Some(value) = value.as_int32() {
                    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_INT, value as u32, 0);
                } else if let Some(value) = value.as_float32() {
                    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_FLOAT, value.to_bits(), 0);
                } else if let Some(value) = value.as_bool() {
                    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_BOOL, value as u32, 0);
                } else if let Some(value) = value.as_str() {
                    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_STRING, value.as_ptr() as u32, value.len() as u32);
                }
            });
            subs.push(sub);
        }
        subs
    }

    /// Wire each sample a device asked to observe (`observe_sample`): catch up to the `file` pointer's current
    /// target and subscribe to that pointer field, so a set / repoint / clear (inside a transaction, never
    /// during render) re-resolves and re-delivers through the device's `sample_changed` export. Returns the
    /// subscriptions for teardown.
    fn observe_samples(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let sample_changed_index = reg.sample_changed_index;
            resolve_and_deliver_sample(&self.graph, device_uuid, path, sample_changed_index, state_ptr, id);
            let owned_path = path.clone();
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_sample(graph, device_uuid, &owned_path, sample_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
    }

    /// Observe each parameter field's value (a reactive `Rc<Cell>`) and its automation track, returning the
    /// per-parameter handles, the field subscriptions + curve collections (for teardown), and whether ANY
    /// parameter is automated (so the node arms the clock). The id is the parameter's index, matching the
    /// id `host_bind_parameter` returned the device.
    fn observe_params(&mut self, device_uuid: Uuid, paths: &[FieldPath], invalidate: &Rc<dyn Fn()>) -> (Vec<ParamHandle>, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut handles = Vec::new();
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        for (index, path) in paths.iter().enumerate() {
            let address = Address::of(device_uuid, path.clone());
            // A parameter field carries its real primitive type — Float32 (a cutoff), Int32 (semitones), or
            // Boolean (a toggle), fixed by the schema. Read it once so the wire can tag the un-automated value
            // with its kind; the device then receives a typed `ParamValue` and never inspects a tag.
            let kind = self.graph.field_value(&address).map_or(PARAM_KIND_FLOAT, |value| {
                if value.as_int32().is_some() { PARAM_KIND_INT }
                else if value.as_bool().is_some() { PARAM_KIND_BOOL }
                else { PARAM_KIND_FLOAT }
            });
            let field = Rc::new(core::cell::Cell::new(0.0f32));
            let cell = field.clone();
            // The field VALUE: keep the live cell in sync, and invalidate so reconcile re-pushes the device
            // (a static parameter's new value must reach it; an automated one re-resolves harmlessly).
            let field_invalidate = invalidate.clone();
            subs.push(self.graph.catchup_and_subscribe(address.clone(), move |value| {
                let real = value.as_float32()
                    .or_else(|| value.as_int32().map(|value| value as f32))
                    .or_else(|| value.as_bool().map(|value| if value {1.0} else {0.0}));
                if let Some(real) = real {
                    cell.set(real);
                    field_invalidate();
                }
            }));
            // Automation ATTACH / DETACH: incoming pointers at the parameter field (a Value track's `target`).
            let attach_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_pointer_hub(address, Box::new(move |_graph, _event| attach_invalidate())));
            let (track, track_uuid, mut track_collections) = build_param_track(&mut self.graph, device_uuid, path);
            if track.is_some() {
                armed = true;
            }
            // Value-region join / leave on the automation track (so the curve's region set stays current).
            if let Some(track_uuid) = track_uuid {
                let region_invalidate = invalidate.clone();
                subs.push(self.graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_REGIONS_KEY]),
                    Box::new(move |_graph, _event| region_invalidate())));
            }
            collections.append(&mut track_collections);
            handles.push(ParamHandle {id: index as u32, field, kind, track, last: Rc::new(core::cell::Cell::new(f32::NAN))});
        }
        (handles, subs, collections, armed)
    }

    /// Push the initial parameter values of freshly built devices (JOINERS) to them. Survivors are NEVER passed
    /// here — a chain edit (reorder / add / remove) must leave every existing plugin's parameters untouched.
    pub(crate) fn refresh_joiner_params(&self, device_params: &[DeviceParams]) {
        let position = self.transport.position();
        for params in device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
    }

    /// Unsubscribe each device's field observers and terminate its curve collections (a rewire / teardown).
    pub(crate) fn teardown_device_params(&mut self, device_params: Vec<DeviceParams>) {
        for params in device_params {
            for sub in params.field_subs {
                self.graph.unsubscribe(sub);
            }
            for sub in params.observe_subs {
                self.graph.unsubscribe(sub);
            }
            for collection in params.collections {
                collection.terminate(&mut self.graph);
            }
        }
    }

    /// Re-bind a unit's device automation after a runtime attach / detach / field edit, WITHOUT rewiring the
    /// audio graph: for each device re-observe its parameters (the field-paths it declared are kept), re-set
    /// them on the node (re-arming or disarming the clock), and push the resolved values. Mirrors TS
    /// `bindParameter` reacting to a parameter's automation pointer hub.
    fn rebind_automation(&mut self, unit: &mut AudioUnitBinding) {
        let invalidate = automation_invalidate(unit);
        let position = self.transport.position();
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        match &mut wired {
            Wired::Leaf(chain) => {
                self.rebind_one(&mut chain.instrument.params, &invalidate, position);
                for member in &mut chain.midi {
                    self.rebind_one(&mut member.params, &invalidate, position);
                }
                for member in &mut chain.audio {
                    self.rebind_one(&mut member.params, &invalidate, position);
                }
            }
            Wired::Composite(composite) => {
                composite.binding.for_each_params(&mut |params| self.rebind_one(params, &invalidate, position));
            }
        }
        unit.wired = Some(wired);
    }

    /// Re-observe ONE device's automation in place: drop the old field subscriptions + curve collections,
    /// re-observe the (unchanged) parameter field-paths, re-set the params on the node (re-arm / disarm the
    /// clock), and push the resolved values. Touches neither the audio graph nor the plain-field / sidechain
    /// observations.
    fn rebind_one(&mut self, params: &mut DeviceParams, invalidate: &Rc<dyn Fn()>, position: f64) {
        // Preserve each parameter's last-pushed value across the re-observe (the paths are unchanged, so the new
        // handles line up by index). Fresh handles start at `last = NaN`, which would re-push EVERY parameter;
        // carrying `last` over means `refresh_params` only pushes the ones whose value actually changed — so a
        // parameter (or whole plugin) unaffected by this automation edit is never re-pushed (and never glides).
        let previous_last: Vec<f32> = params.handles.iter().map(|handle| handle.last.get()).collect();
        for sub in core::mem::take(&mut params.field_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut params.collections) {
            collection.terminate(&mut self.graph);
        }
        let (handles, field_subs, collections, armed) = self.observe_params(params.device_uuid, &params.paths, invalidate);
        for (handle, last) in handles.iter().zip(previous_last) {
            handle.last.set(last);
        }
        params.sink.set_params(handles.clone(), armed);
        refresh_params(&handles, params.reg, params.state_ptr, position);
        params.handles = handles;
        params.field_subs = field_subs;
        params.collections = collections;
    }
}

/// Call a device's `init(state_ptr, sample_rate)` to collect the parameter field-paths it declares (it binds
/// them via `host_bind_parameter`, which records into `BIND`) and let it stash the sample rate. Touches no
/// graph, so it is a free fn.
fn bind_paths(reg: DeviceReg, state_ptr: u32, sample_rate: f32) -> Vec<FieldPath> {
    unsafe { BIND.get() }.clear();
    unsafe { SAMPLE_OBS.get() }.clear();
    unsafe { FIELD_OBS.get() }.clear();
    unsafe { SIDECHAIN_BIND.get() }.clear();
    call_device_init(reg.init_index, state_ptr, sample_rate);
    core::mem::take(unsafe { BIND.get() })
}

/// Push each parameter's resolved value (its automation at `position`, else its real field value) to the
/// device via its `parameter_changed` export, but only when it CHANGED since the last push (the TS
/// `updateAutomation` compare). The `kind` tag tells the device how to read the value (uniform automation to
/// map, or a real Int / Float / Bool field value). Called at build (every param, `last` is NaN) and on a
/// runtime edit / field change. Never during render.
fn refresh_params(handles: &[ParamHandle], reg: DeviceReg, state_ptr: u32, position: f64) {
    for handle in handles {
        let (value, kind) = handle.resolve(position);
        if value != handle.last.get() {
            handle.last.set(value);
            call_device_parameter_changed(reg.parameter_changed_index, state_ptr, handle.id, kind, value);
        }
    }
}

/// Resolve a device's observed sample pointer to a handle and deliver it via `sample_changed`: a resident
/// handle when the `file` pointer targets an `AudioFileBox` (the frames are requested through `SAMPLES`), or
/// "unbound" (`present = 0`) when the pointer has no target (cleared). Touches `SAMPLES` (its own cell) and the
/// device, never `&mut Engine`, so it is safe from a transaction observer.
fn resolve_and_deliver_sample(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], sample_changed_index: u32, state_ptr: u32, id: u32) {
    match graph.target_of(&Address::of(device_uuid, path.to_vec())) {
        Some(target) => {
            let handle = unsafe { SAMPLES.get() }.request(target.uuid);
            call_device_sample_changed(sample_changed_index, state_ptr, id, handle, 1);
        }
        None => call_device_sample_changed(sample_changed_index, state_ptr, id, 0, 0)
    }
}

/// The automation curve for a device parameter, if a Value track targets `(device_uuid, path)`: build a
/// `ParamCurve` over that track's value regions and return it with the collections to terminate. `None` (and
/// no collections) when the parameter has no automation track.
fn build_param_track(graph: &mut BoxGraph, device_uuid: Uuid, path: &[u16]) -> (Option<ParamCurve>, Option<Uuid>, Vec<ValueCollection>) {
    // Find the Value track whose `target` points at this parameter. NOTE: this scans every TrackBox — it can
    // NOT use `graph.incoming(param)`, because a parameter address is a device-internal field path that is not
    // always a RESOLVED graph vertex (deep param paths), so the track's target edge is "dangling" and absent
    // from `incoming`. The cost is O(TrackBoxes), smaller than the value-region scan below (now targeted).
    let track_uuid = {
        let mut found = None;
        for track in graph.find_all_by_name("TrackBox") {
            if let Some(target) = graph.target_of(&Address::of(track.uuid, vec![TRACK_TARGET_KEY])) {
                if target.uuid == device_uuid && target.field_keys.as_slice() == path {
                    found = Some(track.uuid);
                    break;
                }
            }
        }
        found
    };
    let track_uuid = match track_uuid {
        Some(uuid) => uuid,
        None => return (None, None, Vec::new())
    };
    let mut regions = RegionCollection::new();
    let mut collections = Vec::new();
    for spec in value_regions_of_track(graph, track_uuid) {
        let collection = ValueCollection::observe(graph, spec.collection);
        regions.add(ValueBoundRegion {
            position: spec.position, duration: spec.duration,
            loop_offset: spec.loop_offset, loop_duration: spec.loop_duration,
            curve: collection.curve()
        });
        collections.push(collection);
    }
    (Some(ParamCurve::new(regions)), Some(track_uuid), collections)
}

// ---- The track / region cascade beneath an audio unit. Free functions taking `&mut BoxGraph`: they only
// observe the box graph and edit the per-track region collections + the unit's note-event cache, never the
// processor graph, so they avoid borrowing the engine. Membership is recorded into `Members` + drained
// here; a region's span EDIT re-sorts its track collection live via the track's `edit_sub` observer. ----

/// Reconcile one unit's tracks against its `tracks` membership, then each track's regions. A new track's
/// region collection is registered into the unit's shared `track_sets` (so the sequencer sees it); a
/// removed track's collection is unregistered.
fn reconcile_tracks(graph: &mut BoxGraph, unit: &mut AudioUnitBinding) {
    let mark = unit.mark.clone();
    let changes = core::mem::take(&mut *unit.track_changes.borrow_mut());
    for track_uuid in changes.removed {
        if let Some(index) = unit.tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.tracks.remove(index);
            teardown_track(graph, &unit.track_sets, &mut unit.collections, track);
        }
    }
    for track_uuid in changes.added {
        if unit.tracks.iter().any(|track| track.track_uuid == track_uuid) {
            continue;
        }
        if track_type(graph, track_uuid) == TRACK_TYPE_VALUE {
            continue; // a Value (automation) track is read per-device by `device_automation`, not the note cascade
        }
        let track = build_track(graph, track_uuid, &mark);
        unit.track_sets.borrow_mut().push(track.regions_set.clone());
        unit.tracks.push(track);
    }
    for track in &mut unit.tracks {
        reconcile_regions(graph, &mut unit.collections, track);
    }
}

/// Build a track binding: its own sorted region collection (`regions_set`), a subscription to the track's
/// `regions` membership (key 3), and an edit subscription that re-sorts the collection when a member
/// region's span (position / duration / loop fields) changes — so a moved region lands at the right place.
fn build_track(graph: &mut BoxGraph, track_uuid: Uuid, mark: &DirtyMark) -> TrackBinding {
    let regions_set: SharedTrackRegions = Rc::new(RefCell::new(RegionCollection::new()));
    let region_changes = Rc::new(RefCell::new(Members::default()));
    let recorder = region_changes.clone();
    let region_mark = mark.clone();
    let region_sub = graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_REGIONS_KEY]), Box::new(move |_graph, event| {
        match event {
            HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
            HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
        }
        region_mark.mark();
    }));
    TrackBinding {track_uuid, regions_set, region_bindings: Vec::new(), region_changes, region_sub}
}

/// Tear down a track: unsubscribe its membership + edit observers, unregister its region collection from the
/// unit's `track_sets`, and release each region's note-event cache reference.
fn teardown_track(graph: &mut BoxGraph, track_sets: &SharedTrackSets, collections: &mut CollectionCache, track: TrackBinding) {
    graph.unsubscribe(track.region_sub);
    track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.regions_set));
    for region in track.region_bindings {
        graph.unsubscribe(region.edit_sub);
        collections.release(graph, region.collection_uuid);
    }
}

/// Reconcile a track's regions against its `regions` membership, maintaining the track's sorted region
/// collection and the unit's note-event cache (releasing on remove, acquiring + sorted-inserting on add).
fn reconcile_regions(graph: &mut BoxGraph, collections: &mut CollectionCache, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.regions_set.borrow_mut().retain(|bound| bound.region_uuid != region_uuid);
            graph.unsubscribe(region.edit_sub);
            collections.release(graph, region.collection_uuid);
        }
    }
    for region_uuid in changes.added {
        if track.region_bindings.iter().any(|region| region.region_uuid == region_uuid) {
            continue;
        }
        if let Some(binding) = build_region(graph, &track.regions_set, collections, region_uuid) {
            track.region_bindings.push(binding);
        }
    }
}

/// Read a region's loopable span, ACQUIRE its note-event collection (`events` pointer key 2) from the cache
/// (observed once, shared by mirrored regions), and sorted-insert it into the track's region collection.
/// `None` if the region has no collection.
fn build_region(graph: &mut BoxGraph, regions_set: &SharedTrackRegions, collections: &mut CollectionCache, region_uuid: Uuid) -> Option<RegionBinding> {
    let region = read_note_region(graph, region_uuid);
    let collection_uuid = graph.target_of(&Address::of(region_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    regions_set.borrow_mut().add(BoundRegion {region_uuid, region, collection});
    // Targeted: a `Parent` sub on the region box re-reads THIS region's span and re-sorts the track's set
    // when (and only when) one of this region's own fields is edited (TS `onIndexingChanged`, per-region).
    let edit_regions = regions_set.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(region_uuid), Box::new(move |graph, _update| {
        let mut set = edit_regions.borrow_mut();
        let mut moved = false;
        for bound in set.iter_mut() {
            if bound.region_uuid == region_uuid {
                bound.region = read_note_region(graph, region_uuid);
                moved = true;
            }
        }
        if moved {
            set.resort();
        }
    }));
    Some(RegionBinding {region_uuid, collection_uuid, edit_sub})
}

/// Read a region's loopable span from the box graph (position 10, duration 11, loopOffset 12, loopDuration 13).
fn read_note_region(graph: &BoxGraph, region_uuid: Uuid) -> NoteRegion {
    NoteRegion {
        position: region_pulses(graph, region_uuid, 10),
        duration: region_pulses(graph, region_uuid, 11),
        loop_offset: region_pulses(graph, region_uuid, 12),
        loop_duration: region_pulses(graph, region_uuid, 13)
    }
}

fn region_pulses(graph: &BoxGraph, uuid: Uuid, key: u16) -> f64 {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
}

// ---- Device parameter automation (Route D). A device's automated parameter is a Value `TrackBox` whose
// `target` points at the parameter field; the engine observes its curve and hands the device a read handle,
// and the device pulls the value on each global clock event. Discovered per device at rewire (mirroring TS
// `bindParameter` connecting a parameter's automation track), independent of the note-region cascade. ----

// TrackBox.type (field 11) values mirror studio-adapters `TrackType`; only a Value track carries parameter
// automation (Note / Audio tracks and the unset default go through the note cascade).
const TRACK_TYPE_VALUE: i32 = 3;
const TRACK_TYPE_KEY: u16 = 11;
const TRACK_TARGET_KEY: u16 = 2;        // TrackBox.target -> the automated parameter field (Automation pointer)
const TRACK_REGIONS_KEY: u16 = 3;       // TrackBox.regions -> the hub value regions attach to (membership)
const VALUE_REGION_EVENTS_KEY: u16 = 2; // ValueRegionBox.events -> the ValueEventCollectionBox

/// One value region of an automation track: its `events` collection and loopable span.
struct RegionSpec {
    collection: Uuid,
    position: f64,
    duration: f64,
    loop_offset: f64,
    loop_duration: f64
}

/// Every value region of an automation track: the `ValueRegionBox`es whose `regions` points at `track_uuid`,
/// with their `events` collection and span (position 10, duration 11, loopOffset 12, loopDuration 13). Read
/// from the track's `regions` hub (the incoming pointers) — O(regions on this track) — not a full-graph scan.
fn value_regions_of_track(graph: &BoxGraph, track_uuid: Uuid) -> Vec<RegionSpec> {
    let mut specs = Vec::new();
    let regions_hub = Address::of(track_uuid, vec![TRACK_REGIONS_KEY]);
    for source in graph.incoming(&regions_hub) {
        let region_uuid = source.uuid;
        if !graph.find_box(&region_uuid).is_some_and(|graph_box| graph_box.name == "ValueRegionBox") {
            continue; // a note/audio region could share the hub key; only value regions carry automation
        }
        if let Some(collection) = graph.target_of(&Address::of(region_uuid, vec![VALUE_REGION_EVENTS_KEY])).map(|address| address.uuid) {
            specs.push(RegionSpec {
                collection,
                position: region_pulses(graph, region_uuid, 10),
                duration: region_pulses(graph, region_uuid, 11),
                loop_offset: region_pulses(graph, region_uuid, 12),
                loop_duration: region_pulses(graph, region_uuid, 13)
            });
        }
    }
    specs
}

/// A track's `type` (field 11), defaulting to 0 (Undefined) when unset.
fn track_type(graph: &BoxGraph, track_uuid: Uuid) -> i32 {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_TYPE_KEY])).and_then(|value| value.as_int32()).unwrap_or(0)
}


#[cfg(test)]
mod tests {
    //! Mirrored regions: a NoteEventCollectionBox is observed ONCE by the cache and shared by every region
    //! that references it; the observation survives until the last region leaves. Two regions sharing a
    //! collection both read the same events, and removing one leaves the other reading it.
    use super::{build_param_track, CollectionCache};
    use boxgraph::address::{Address, Uuid};
    use boxgraph::boxes::GraphBox;
    use boxgraph::field::{FieldValue, Fields};
    use boxgraph::graph::BoxGraph;

    const COLLECTION: Uuid = [1u8; 16];
    const NOTE: Uuid = [2u8; 16];
    const DEVICE: Uuid = [9u8; 16];
    const TRACK: Uuid = [8u8; 16];
    const REGION: Uuid = [7u8; 16];
    const VCOLLECTION: Uuid = [6u8; 16];
    const EVENT: Uuid = [4u8; 16];

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    // A collection with one note member, so the observed NoteCollection has exactly one event.
    fn graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(COLLECTION, "NoteEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(NOTE, "NoteEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(COLLECTION, vec![1])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(240)),
                (20, FieldValue::Int32(60)), (21, FieldValue::Float32(0.8)), (24, FieldValue::Float32(0.0))
            ])
        ])
    }

    #[test]
    fn shared_collection_is_observed_once_and_refcounted() {
        let mut graph = graph();
        let mut cache = CollectionCache::default();
        let base = graph.subscription_count();

        // First region acquires: the collection is observed once and reads its one note.
        let region_a = cache.acquire(&mut graph, COLLECTION);
        let observed = graph.subscription_count();
        assert!(observed > base, "first acquire observes the collection");
        assert_eq!(region_a.len(), 1);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.entries[0].refs, 1);

        // A mirrored region acquires the SAME collection: no new observation, shared event list.
        let region_b = cache.acquire(&mut graph, COLLECTION);
        assert_eq!(graph.subscription_count(), observed, "a mirrored region adds no new subscription");
        assert_eq!(region_b.len(), 1, "the mirrored region reads the same events");
        assert_eq!(cache.entries[0].refs, 2);

        // Remove one region: the observation survives and the other still reads it.
        cache.release(&mut graph, COLLECTION);
        assert_eq!(cache.entries[0].refs, 1);
        assert_eq!(graph.subscription_count(), observed, "still observed while a region remains");
        assert_eq!(region_a.len(), 1, "the surviving region still reads the collection");

        // Remove the last region: the observation is terminated.
        cache.release(&mut graph, COLLECTION);
        assert!(cache.entries.is_empty());
        assert_eq!(graph.subscription_count(), base, "the last release unsubscribes the observation");
    }

    // A full automation chain (Value track -> region -> ValueEventCollection -> one event) whose track
    // `target` reaches a parameter at `path` on the device. Used to prove the key is the path at any depth.
    fn deep_automation_graph(path: &[u16]) -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(DEVICE, "RevampDeviceBox", &[]),
            graph_box(TRACK, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))), // target -> the deep field
                (3, FieldValue::Hook)                                               // regions hub
            ]),
            graph_box(REGION, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),         // regions -> track.regions
                (2, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![2])))),   // events -> collection.owners
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
                (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(VCOLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(EVENT, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![1])))),   // events -> collection.events
                (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.7))
            ])
        ])
    }

    // ---- Per-member processor lifecycle ----
    // Adding an effect to a unit's audio chain must KEEP the existing processors (instrument + surviving
    // effects), creating only the joiner — not tear down and rebuild the whole cluster, which would reset
    // every survivor's DSP state. We prove identity by NodeId: ids are handed out monotonically and never
    // reused, so a rebuilt processor always gets a fresh (larger) id. A survivor keeping its id == its
    // processor instance was kept.
    use alloc::rc::Rc;
    use core::cell::RefCell;
    use crate::{DeviceReg, Engine, EFFECT_INDEX_KEY};
    use super::{AudioUnitBinding, Wired, DEVICE_KIND_INSTRUMENT, UNIT_MIDI_KEY, UNIT_INPUT_KEY, UNIT_AUDIO_KEY, UNIT_TRACKS_KEY, DEVICE_ENABLED_KEY};
    use abi::DEVICE_KIND_AUDIO_EFFECT;
    use boxgraph::updates::Update;
    use engine_env::engine_context::NodeId;
    use engine_env::audio_buffer::shared_audio_buffer;
    use engine_env::audio_bus_processor::AudioBusProcessor;

    // The instrument node id + the audio-fx node ids (in chain order) of a reconciled leaf unit.
    fn leaf_nodes(unit: &AudioUnitBinding) -> (NodeId, Vec<NodeId>) {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => (
                chain.instrument.node_id.expect("instrument node"),
                chain.audio.iter().map(|member| member.node_id.expect("audio node")).collect()
            ),
            _ => panic!("expected a leaf chain")
        }
    }

    fn leaf_sequencer(unit: &AudioUnitBinding) -> engine_env::note_event_instrument::SharedNoteEventSource {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => chain.sequencer.clone(),
            _ => panic!("expected a leaf chain")
        }
    }

    // The wired signal-path edges of a leaf unit. `node_in_path` says whether a processor node is connected.
    fn leaf_edges(unit: &AudioUnitBinding) -> Vec<(NodeId, NodeId)> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => chain.edges.clone(),
            _ => panic!("expected a leaf chain")
        }
    }
    fn node_in_path(edges: &[(NodeId, NodeId)], node: NodeId) -> bool {
        edges.iter().any(|(source, target)| *source == node || *target == node)
    }

    const UNIT: Uuid = [10u8; 16];
    const INSTR: Uuid = [11u8; 16];
    const FX_A: Uuid = [12u8; 16];
    const FX_B: Uuid = [13u8; 16];
    const HOST_KEY: u16 = 1; // the device's `host` pointer field (-> the unit's chain hub)

    fn stub_device(kind: u32) -> DeviceReg {
        DeviceReg {
            process_index: 0, state_size: 64, kind, init_index: 0, parameter_changed_index: 0,
            field_changed_index: 0, sample_changed_index: 0, reset_index: 0,
            midi_effects_field: 0, audio_effects_field: 0
        }
    }

    // A unit with an instrument on `input` (host 22) and ONE audio effect (FX_A, index 0) on the audio
    // chain (host 23). FX_B exists but is not yet connected (host pointer None), so it joins later.
    fn unit_graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
            ]),
            graph_box(FX_A, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
                (EFFECT_INDEX_KEY, FieldValue::Int32(0))
            ]),
            graph_box(FX_B, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(None)),
                (EFFECT_INDEX_KEY, FieldValue::Int32(1))
            ])
        ])
    }

    fn engine_with_devices() -> Engine {
        let mut engine = Engine::new(48_000.0);
        engine.devices = vec![stub_device(DEVICE_KIND_INSTRUMENT), stub_device(DEVICE_KIND_AUDIO_EFFECT)];
        engine.device_box_types = vec![("TestInstrument".to_string(), 0), ("TestEffect".to_string(), 1)];
        let output_buffer = shared_audio_buffer();
        let master = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer)));
        engine.master_id = engine.context.register_processor(master.clone());
        engine.master = Some(master);
        engine
    }

    #[test]
    fn adding_an_effect_keeps_the_existing_processors() {
        let mut engine = engine_with_devices();
        engine.graph = unit_graph();
        let mut unit = engine.build_unit(UNIT);
        // First reconcile builds the chain: instrument + FX_A.
        engine.reconcile_one(&mut unit);
        let (instr_node, audio_before) = leaf_nodes(&unit);
        assert_eq!(audio_before.len(), 1, "one audio effect (FX_A) before");
        let fx_a_node = audio_before[0];

        // Connect FX_B (index 1) to the audio chain via a real pointer transaction, so the audio
        // IndexedCollection observes the join and marks the unit dirty.
        let connect = Update::Pointer {
            address: Address::of(FX_B, vec![HOST_KEY]),
            old: None,
            new: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY]))
        };
        engine.graph.transaction(&[connect], &engine.registry).expect("connect FX_B");
        assert_eq!(unit.audio.sorted(), vec![FX_A, FX_B], "FX_B joined the audio chain in index order");

        // Second reconcile: FX_B joins. The instrument and FX_A must be the SAME processors (same ids).
        engine.reconcile_one(&mut unit);
        let (instr_after, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after.len(), 2, "FX_A + FX_B after");
        assert_eq!(instr_after, instr_node, "instrument processor identity preserved across chain edit");
        assert_eq!(audio_after[0], fx_a_node, "surviving effect FX_A processor identity preserved");
        assert!(audio_after[1] > fx_a_node, "the joiner FX_B is a freshly created processor");
    }

    #[test]
    fn reordering_effects_keeps_their_processors() {
        let mut engine = engine_with_devices();
        engine.graph = unit_graph();
        let mut unit = engine.build_unit(UNIT);
        // Connect FX_B (index 1) so the chain is [FX_A(0), FX_B(1)].
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(FX_B, vec![HOST_KEY]), old: None, new: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY]))
        }], &engine.registry).expect("connect FX_B");
        engine.reconcile_one(&mut unit);
        let (_, audio_before) = leaf_nodes(&unit);
        assert_eq!(audio_before.len(), 2);
        let (fx_a_node, fx_b_node) = (audio_before[0], audio_before[1]);

        // SWAP the indices (a pure reorder): FX_A -> 1, FX_B -> 0, so the chain becomes [FX_B, FX_A].
        engine.graph.transaction(&[
            Update::Primitive {address: Address::of(FX_A, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(0), new: FieldValue::Int32(1)},
            Update::Primitive {address: Address::of(FX_B, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(1), new: FieldValue::Int32(0)}
        ], &engine.registry).expect("swap indices");
        assert_eq!(unit.audio.sorted(), vec![FX_B, FX_A], "the chain reordered");

        // A reorder must ONLY rewire edges: both processors keep their identity (no rebuild -> no DSP reset /
        // delay-offset glide). The order of the node list follows the new chain order.
        let sequencer_before = leaf_sequencer(&unit);
        engine.reconcile_one(&mut unit);
        let (_, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after, vec![fx_b_node, fx_a_node],
            "reorder keeps the SAME processors, just re-ordered (FX_B then FX_A)");
        // And it must reuse the instrument's note source: recreating it would drop the notes held across blocks
        // (stuck / re-triggered notes while playing).
        assert!(Rc::ptr_eq(&sequencer_before, &leaf_sequencer(&unit)),
            "reorder reuses the instrument's note sequencer (held notes preserved)");
    }

    #[test]
    fn a_disabled_effect_is_bypassed_and_re_enabling_re_wires_it_edge_only() {
        let mut engine = engine_with_devices();
        // Unit: instrument + FX_A (enabled, index 0) + FX_B (DISABLED, index 1).
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
            graph_box(FX_A, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))), (EFFECT_INDEX_KEY, FieldValue::Int32(0))
            ]),
            graph_box(FX_B, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))), (EFFECT_INDEX_KEY, FieldValue::Int32(1)),
                (DEVICE_ENABLED_KEY, FieldValue::Boolean(false)) // disabled
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let (_, audio) = leaf_nodes(&unit);
        assert_eq!(audio.len(), 2, "BOTH effects are built (a disabled effect's processor persists)");
        let (fx_a, fx_b) = (audio[0], audio[1]);
        let edges = leaf_edges(&unit);
        assert!(node_in_path(&edges, fx_a), "FX_A (enabled) is in the signal path");
        assert!(!node_in_path(&edges, fx_b), "FX_B (disabled) is BYPASSED — no edge touches it");

        // Enable FX_B: this must RE-WIRE edges only — the SAME processors, no rebuild, no param push.
        engine.graph.transaction(&[Update::Primitive {
            address: Address::of(FX_B, vec![DEVICE_ENABLED_KEY]),
            old: FieldValue::Boolean(false), new: FieldValue::Boolean(true)
        }], &engine.registry).expect("enable FX_B");
        engine.reconcile_one(&mut unit);
        let (_, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after, vec![fx_a, fx_b], "same processor instances (edge-only re-wire, no rebuild)");
        assert!(node_in_path(&leaf_edges(&unit), fx_b), "FX_B is now wired into the signal path");
    }

    // ---- Composite per-child lifecycle ----
    // A composite (Playfield) unit: adding a child slot must KEEP the existing slots' processors. Same
    // identity-by-NodeId proof as the leaf case, one level down.
    use crate::CompositeSpec;

    const COMPOSITE: Uuid = [30u8; 16];
    const CHILD_A: Uuid = [31u8; 16];
    const CHILD_B: Uuid = [32u8; 16];
    const CHILDREN_FIELD: u16 = 30; // the composite's child-slot host hub

    // A unit whose instrument is a composite hosting direct-instrument children (no choke, no routing). CHILD_A
    // is connected; CHILD_B exists but joins later. The children are `TestInstrument` voices.
    fn composite_graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(COMPOSITE, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))),
                (CHILDREN_FIELD, FieldValue::Hook)
            ]),
            graph_box(CHILD_A, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))))
            ]),
            graph_box(CHILD_B, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(None))
            ])
        ])
    }

    fn child_instrument_node(unit: &AudioUnitBinding, child: Uuid) -> Option<NodeId> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.child_instrument_node(child),
            _ => panic!("expected a composite chain")
        }
    }

    // How many child outputs the composite's summing bus currently mixes (a removed child must leave the sum,
    // else its stale buffer keeps sounding).
    fn composite_sum_sources(unit: &AudioUnitBinding) -> usize {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.sum.borrow().audio_source_count(),
            _ => panic!("expected a composite chain")
        }
    }

    fn composite_engine() -> Engine {
        let mut engine = engine_with_devices(); // TestInstrument + TestEffect device table
        engine.composites = vec![CompositeSpec {
            box_type: "TestComposite".to_string(), children_field: CHILDREN_FIELD, index_key: 0, exclude_key: 0,
            cell_instrument_field: 0, cell_midi_field: 0, cell_audio_field: 0 // direct instruments, no choke
        }];
        engine
    }

    #[test]
    fn adding_a_composite_child_keeps_the_existing_children() {
        let mut engine = composite_engine();
        engine.graph = composite_graph();
        let mut unit = engine.build_unit(UNIT);
        // First reconcile builds the composite with CHILD_A summed.
        engine.reconcile_one(&mut unit);
        let child_a_node = child_instrument_node(&unit, CHILD_A).expect("CHILD_A built");

        // Connect CHILD_B to the composite's child hub, so the children collection observes the join.
        let connect = Update::Pointer {
            address: Address::of(CHILD_B, vec![HOST_KEY]),
            old: None,
            new: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))
        };
        engine.graph.transaction(&[connect], &engine.registry).expect("connect CHILD_B");

        // Second reconcile: CHILD_B joins. CHILD_A's instrument processor must be the SAME (its voices live on).
        engine.reconcile_one(&mut unit);
        let child_a_after = child_instrument_node(&unit, CHILD_A).expect("CHILD_A survives");
        let child_b_node = child_instrument_node(&unit, CHILD_B).expect("CHILD_B joined");
        assert_eq!(child_a_after, child_a_node, "existing composite child keeps its processor identity");
        assert!(child_b_node > child_a_node, "the joining child is a freshly created processor");
    }

    #[test]
    fn removing_a_composite_child_keeps_the_others() {
        let mut engine = composite_engine();
        engine.graph = composite_graph();
        let mut unit = engine.build_unit(UNIT);
        // Connect CHILD_B so both A and B are children.
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(CHILD_B, vec![HOST_KEY]), old: None, new: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))
        }], &engine.registry).expect("connect CHILD_B");
        engine.reconcile_one(&mut unit);
        let child_b_node = child_instrument_node(&unit, CHILD_B).expect("CHILD_B built");
        assert_eq!(composite_sum_sources(&unit), 2, "both children feed the sum");

        // Disconnect CHILD_A: it leaves, CHILD_B must survive untouched.
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(CHILD_A, vec![HOST_KEY]), old: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])), new: None
        }], &engine.registry).expect("disconnect CHILD_A");
        engine.reconcile_one(&mut unit);
        assert_eq!(child_instrument_node(&unit, CHILD_A), None, "the removed child is gone");
        assert_eq!(child_instrument_node(&unit, CHILD_B), Some(child_b_node), "the surviving child keeps its processor");
        assert_eq!(composite_sum_sources(&unit), 1, "the removed child no longer feeds the sum (no stale buffer)");
    }

    #[test]
    fn build_param_track_resolves_the_full_field_path_at_any_depth() {
        // A three-level path — deeper than the old packed u32 key could ever represent — resolves the track.
        let deep = [16u16, 5, 10];
        let mut graph = deep_automation_graph(&deep);
        let (curve, track_uuid, collections) = build_param_track(&mut graph, DEVICE, &deep);
        let curve = curve.expect("the parameter at the deep path has an automation track");
        assert_eq!(track_uuid, Some(TRACK), "the targeting track is found (its region hub is then watched)");
        assert_eq!(collections.len(), 1, "its one value region's collection is observed");
        assert_eq!(curve.value_at(0.0, -1.0), 0.7, "and the curve reads its event through that path");
        // A different path on the same device has no track.
        let (none, _, _) = build_param_track(&mut graph, DEVICE, &[16, 5, 11]);
        assert!(none.is_none(), "an unbound path has no automation track");
    }

    #[test]
    fn build_param_track_resolves_only_the_targeting_track_among_unrelated_ones() {
        // Two automation chains on ONE device at DIFFERENT parameter paths. The targeted (incoming-pointer)
        // lookup must resolve each parameter to its OWN track and ONLY that track's value regions — never the
        // other chain's. This is the behaviour the find_all_by_name scans had; it must survive the rewrite.
        const TRACK_B: Uuid = [18u8; 16];
        const REGION_B: Uuid = [17u8; 16];
        const VCOLLECTION_B: Uuid = [16u8; 16];
        const EVENT_B: Uuid = [15u8; 16];
        let path_a = [5u16];
        let path_b = [6u16];
        let chain = |track: Uuid, region: Uuid, collection: Uuid, event: Uuid, path: &[u16], value: f32| vec![
            graph_box(track, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))),
                (3, FieldValue::Hook)
            ]),
            graph_box(region, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(track, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(collection, vec![2])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(collection, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(event, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(collection, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(value))
            ])
        ];
        let mut boxes = vec![graph_box(DEVICE, "RevampDeviceBox", &[])];
        boxes.extend(chain(TRACK, REGION, VCOLLECTION, EVENT, &path_a, 0.7));
        boxes.extend(chain(TRACK_B, REGION_B, VCOLLECTION_B, EVENT_B, &path_b, 0.3));
        let mut graph = BoxGraph::from_boxes(boxes);

        let (curve_a, track_a, cols_a) = build_param_track(&mut graph, DEVICE, &path_a);
        assert_eq!(track_a, Some(TRACK), "param A resolves to its own track");
        assert_eq!(cols_a.len(), 1, "param A observes ONLY its own track's value region");
        assert_eq!(curve_a.expect("curve A").value_at(0.0, -1.0), 0.7);

        let (curve_b, track_b, cols_b) = build_param_track(&mut graph, DEVICE, &path_b);
        assert_eq!(track_b, Some(TRACK_B), "param B resolves to the OTHER track");
        assert_eq!(cols_b.len(), 1, "param B observes ONLY its own track's value region");
        assert_eq!(curve_b.expect("curve B").value_at(0.0, -1.0), 0.3);
    }

    #[test]
    fn param_curve_holds_boundary_values_around_and_between_regions() {
        // Two value regions on one track: A spans [0,100) holding 0.2, B spans [200,300) holding 0.8.
        // `ParamCurve::value_at` must (TS `TrackBoxAdapter.valueAt`): before the first region read its
        // INCOMING value; inside a region read its curve; OUTSIDE a region (the gap after it, or past the
        // last) HOLD that region's OUTGOING value — never jump to the next region early or fall back.
        const REGION_A: Uuid = [20u8; 16];
        const COLL_A: Uuid = [21u8; 16];
        const EVENT_A: Uuid = [22u8; 16];
        const REGION_B: Uuid = [23u8; 16];
        const COLL_B: Uuid = [24u8; 16];
        const EVENT_B: Uuid = [25u8; 16];
        let path = [5u16];
        // One constant-value region: events collection with a single event (held) at local 0.
        let region = |region: Uuid, collection: Uuid, event: Uuid, position: i32, value: f32| vec![
            graph_box(region, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(collection, vec![2])))),
                (10, FieldValue::Int32(position)), (11, FieldValue::Int32(100)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(0))
            ]),
            graph_box(collection, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(event, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(collection, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(value))
            ])
        ];
        let mut boxes = vec![
            graph_box(DEVICE, "RevampDeviceBox", &[]),
            graph_box(TRACK, "TrackBox", &[(2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))), (3, FieldValue::Hook)])
        ];
        boxes.extend(region(REGION_A, COLL_A, EVENT_A, 0, 0.2));
        boxes.extend(region(REGION_B, COLL_B, EVENT_B, 200, 0.8));
        let mut graph = BoxGraph::from_boxes(boxes);
        let curve = build_param_track(&mut graph, DEVICE, &path).0.expect("two regions -> a curve");

        assert_eq!(curve.value_at(-10.0, -1.0), 0.2, "before the first region: its incoming value");
        assert_eq!(curve.value_at(50.0, -1.0), 0.2, "inside region A");
        assert_eq!(curve.value_at(150.0, -1.0), 0.2, "in the gap after A: A's HELD outgoing value, not B's");
        assert_eq!(curve.value_at(250.0, -1.0), 0.8, "inside region B");
        assert_eq!(curve.value_at(500.0, -1.0), 0.8, "past the last region: B's HELD outgoing value");
    }
}
