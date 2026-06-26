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
use crate::{call_device_init, call_device_field_changed, call_device_parameter_changed, call_device_sample_changed, DeviceReg, Engine, PullLink, BIND, FIELD_OBS, SAMPLE_OBS, SAMPLES, SIDECHAIN_BIND, EFFECT_INDEX_KEY};

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

/// The processor nodes + edges the engine wired for one unit (its teardown set, the analog of TS
/// `AudioDeviceChain`'s `#disconnector`): everything to drop before a rebuild. `output_buffer` is the last
/// node's buffer, fed into the master bus.
struct WiredCluster {
    nodes: Vec<NodeId>,
    edges: Vec<(NodeId, NodeId)>,
    output_buffer: SharedAudioBuffer,
    // The bound parameters of each device in this cluster (instrument + audio-fx). Owned here so a rewire /
    // teardown unsubscribes the field observers + terminates the curve collections, and so a runtime
    // automation change can re-observe + re-push WITHOUT rewiring the audio graph (`rebind_automation`).
    device_params: Vec<DeviceParams>
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
    // When the unit's instrument is a COMPOSITE (e.g. Playfield), its child-collection cascade (owned by the
    // `composite` module). `None` for a leaf instrument or no instrument. A slot add / remove raises its
    // `take_dirty`, so the unit re-wires; teardown terminates it. The engine knows nothing else about it.
    composite: Option<CompositeBinding>,
    wired: Option<WiredCluster>,
    // Set by a parameter's TARGETED automation subscriptions (see `observe_params` / `automation_invalidate`)
    // when a Value track attaches / detaches or its data changes; `reconcile_one` then re-binds the unit's
    // curves (no rewire) and clears it.
    automation_dirty: Rc<Cell<bool>>,
    // Enqueues THIS unit for a targeted reconcile when any of its scope subscriptions (chains, tracks,
    // regions, automation, composite, sidechain pointers) fire — so a related edit rewires one unit.
    mark: DirtyMark,
    // The unit's persistent sidechain bindings (this unit's audio fx + its composite children's), re-resolved
    // by the resolve pass. Each port carries its own TARGETED pointer monitor (see `SidechainPort`).
    sidechains: Vec<SidechainBinding>
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
            self.graph.subscribe_pointer_hub(Address::of(root.uuid, vec![20]), Box::new(move |_graph, event| {
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
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![12]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![13]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![14]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // THE output unit's own audio-effect chain (e.g. a master Tidal), wired between the summing bus and
        // the master strip: bus -> fx0 -> ... -> strip, ordered by device index. Each device binds its
        // parameters like an instrument unit's, and the initial values are pushed below. Built once at bind
        // (the output unit is a fixed singleton), so the chain is not reactive yet.
        let mut source = master_output;
        let mut source_id = self.master_id;
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![23]), EFFECT_INDEX_KEY);
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
        let composite_dirty = unit.composite.as_ref().is_some_and(|composite| composite.take_dirty());
        let dirty = unit.input.take_dirty() | unit.midi.take_dirty() | unit.audio.take_dirty() | composite_dirty;
        if dirty {
            self.rewire_unit(unit);
        } else if unit.automation_dirty.get() {
            self.rebind_automation(unit);
            unit.automation_dirty.set(false);
        }
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
            for binding in &mut unit.sidechains {
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
        }
        self.audio_units = units;
    }

    /// Remove a unit entirely: drop its wired cluster (edges, nodes, bus source), unsubscribe its tracks
    /// membership + track cascade, and terminate its three device-chain collections.
    fn teardown_unit(&mut self, mut binding: AudioUnitBinding) {
        if let Some(wired) = binding.wired.take() {
            self.teardown_wired(&wired);
            self.teardown_device_params(wired.device_params);
        }
        self.teardown_sidechains(core::mem::take(&mut binding.sidechains));
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
        if let Some(composite) = binding.composite {
            composite.terminate(&mut self.graph);
        }
    }

    /// Drop a unit's sidechain bindings: unsubscribe each port's TARGETED pointer monitor. The resolved
    /// producer -> consumer edges are removed with the effect nodes by `teardown_wired`.
    fn teardown_sidechains(&mut self, sidechains: Vec<SidechainBinding>) {
        for binding in sidechains {
            for port in binding.ports {
                self.graph.unsubscribe(port.pointer_sub);
            }
        }
    }

    /// Drop a wired cluster's processor graph: unwire its output from the master bus, remove its edges, and
    /// remove its nodes. The teardown set, the analog of TS `AudioDeviceChain`'s `#disconnector.terminate`.
    fn teardown_wired(&mut self, wired: &WiredCluster) {
        if let Some(master) = &self.master {
            master.borrow_mut().remove_audio_source(&wired.output_buffer);
        }
        for (source, target) in &wired.edges {
            self.context.remove_edge(*source, *target);
        }
        for node in &wired.nodes {
            self.context.remove_processor(*node);
        }
    }

    /// Drop the unit's composite cascade, if any (a leaf instrument or no instrument has none). The
    /// `CompositeBinding` lives in the `composite` module; this just terminates it and clears the field.
    fn drop_composite(&mut self, unit: &mut AudioUnitBinding) {
        if let Some(composite) = unit.composite.take() {
            composite.terminate(&mut self.graph);
        }
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
        let track_sub = self.graph.subscribe_pointer_hub(Address::of(uuid, vec![20]), Box::new(move |_graph, event| {
            match event {
                HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
                HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
            }
            track_mark.mark();
        }));
        // The instrument `input` host holds ONE instrument, which has no `index` field (only effects do). So it
        // is never ordered: key `0` is a non-field, read back as 0 for every member, and the collection is used
        // only for membership + `.first()`. The midi (21) and audio (23) chains ARE effects, ordered by index.
        let input = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![22]), 0);
        let midi = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![21]), EFFECT_INDEX_KEY);
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![23]), EFFECT_INDEX_KEY);
        // A chain edit (add / remove / reorder a device) enqueues this unit for a targeted reconcile. Wired
        // after `observe` so the catch-up members do not fire it; the new unit enqueues itself once below.
        input.set_on_dirty(mark.signal());
        midi.set_on_dirty(mark.signal());
        audio.set_on_dirty(mark.signal());
        // The channel strip's parameters, kept in sync with the unit's box: volume (12, dB), panning (13),
        // mute (14). Reactive but no rewire needed — the strip reads these Cells each block.
        let strip_params = Rc::new(StripParams::new());
        let volume = strip_params.clone();
        let volume_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![12]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = strip_params.clone();
        let panning_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![13]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = strip_params.clone();
        let mute_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![14]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // Automation reactivity is per-parameter and TARGETED (see `observe_params`): each parameter's field
        // value, its automation pointer-hub, and its track's region hub fire `automation_invalidate`, which
        // sets this flag + enqueues the unit, so `reconcile_one` re-binds the unit's curves (no rewire). No
        // per-unit all-updates observer.
        let automation_dirty = Rc::new(Cell::new(false));
        AudioUnitBinding {
            unit: uuid, track_sets, collections: CollectionCache::default(), tracks: Vec::new(),
            track_changes, track_sub, strip_params, strip_subs: vec![volume_sub, panning_sub, mute_sub],
            input, midi, audio, composite: None, wired: None, automation_dirty, mark,
            sidechains: Vec::new()
        }
    }

    /// (Re)build a unit's processor cluster from the current device table + the sorted chains: instrument
    /// (the `input` device), the midi-fx pull chain folded in index order under it, and the audio-fx chain
    /// wired instrument -> fx0 -> ... -> bus in index order. Tears down the old cluster first. A unit with no
    /// resolvable instrument is left silent (wired = None). The whole device set is realized this way; the
    /// only per-device knowledge is the box-type -> plugin table.
    fn rewire_unit(&mut self, unit: &mut AudioUnitBinding) {
        if let Some(wired) = unit.wired.take() {
            self.teardown_wired(&wired);
            self.teardown_device_params(wired.device_params);
        }
        self.teardown_sidechains(core::mem::take(&mut unit.sidechains)); // drop the old ports' pointer monitors
        let instrument_uuid = match unit.input.sorted().first().copied() {
            Some(uuid) => uuid,
            None => {
                self.drop_composite(unit);
                return // no instrument yet: the unit stays silent until its `input` device box appears
            }
        };
        let box_name = match self.graph.find_box(&instrument_uuid) {
            Some(device_box) => device_box.name.clone(),
            None => {
                self.drop_composite(unit);
                return
            }
        };
        // Enqueues this unit when a chain / child / sidechain pointer of its scope changes (the targeted
        // subscriptions' notify), plus the parameter `invalidate` (which also sets `automation_dirty`).
        // Both threaded through the whole cluster build.
        let signal = unit.mark.signal();
        let invalidate = automation_invalidate(unit);
        let mut cluster = if let Some(spec) = self.composite_for_type(&box_name) {
            // A COMPOSITE instrument (e.g. Playfield): the `composite` module builds one child per slot and
            // sums them. The engine stays mapping-agnostic — `spec` (a registered entry) names the slot
            // collection; nothing Playfield-specific lives here. The unit's own midi / audio chains are not
            // wrapped around a composite yet (a composite's effects live per child, step 5).
            self.drop_composite(unit);
            let track_sets = unit.track_sets.clone();
            let (cluster, binding) = self.build_composite(&track_sets, instrument_uuid, &spec, &signal, &invalidate);
            unit.composite = Some(binding);
            cluster
        } else {
            self.drop_composite(unit); // a leaf instrument: drop any stale composite cascade
            let instrument_device = match self.device_for_type(&box_name) {
                Some(device) if device.kind == DEVICE_KIND_INSTRUMENT => device,
                _ => return
            };
            // The pull-chain leaf: a sequencer over the unit's per-track region collections. It reads
            // `track_sets` live, so track / region changes need no rewire. `build_cluster` folds the midi-fx
            // chain on top in index order and builds the instrument + audio-fx chain.
            let sequencer: SharedNoteEventSource =
                Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: unit.track_sets.clone()}))));
            let midi = unit.midi.sorted();
            let audio = unit.audio.sorted();
            self.build_cluster(PullLink::Source(sequencer), instrument_uuid, instrument_device, &midi, &audio, &signal, &invalidate)
        };
        // The channel strip terminates the unit's chain: instrument/fx -> STRIP -> master. It applies the
        // unit's volume / panning / mute (read from the shared StripParams), then feeds the master bus.
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(cluster.output);
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip);
        self.context.register_edge(cluster.output_node, strip_id);
        cluster.edges.push((cluster.output_node, strip_id));
        cluster.nodes.push(strip_id);
        // Register the unit's OUTPUT (its strip) by box address, so a sidechain pointing at this unit resolves to
        // this buffer + node in the post-build pass.
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        let master = self.master.as_ref().unwrap();
        master.borrow_mut().add_audio_source(strip_output.clone());
        self.context.register_edge(strip_id, self.master_id);
        cluster.edges.push((strip_id, self.master_id));
        // Now that every device node exists and its params are bound, push each parameter's initial value
        // (the box-field default, or its automation at the current position) to the device.
        let position = self.transport.position();
        for params in &cluster.device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
        // The fresh per-parameter automation subscriptions are now live; clear any pending flag.
        unit.automation_dirty.set(false);
        // Keep the fresh bindings (resolved = None, each port already carrying its targeted pointer monitor)
        // for the resolve pass to wire up.
        unit.sidechains = core::mem::take(&mut cluster.sidechains);
        unit.wired = Some(WiredCluster {
            nodes: cluster.nodes, edges: cluster.edges, output_buffer: strip_output, device_params: cluster.device_params
        });
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

    /// Unsubscribe each device's field observers and terminate its curve collections (a rewire / teardown).
    fn teardown_device_params(&mut self, device_params: Vec<DeviceParams>) {
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
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        let position = self.transport.position();
        let mut rebound: Vec<DeviceParams> = Vec::new();
        for params in core::mem::take(&mut wired.device_params) {
            for sub in params.field_subs {
                self.graph.unsubscribe(sub);
            }
            for collection in params.collections {
                collection.terminate(&mut self.graph);
            }
            let (handles, field_subs, collections, armed) = self.observe_params(params.device_uuid, &params.paths, &invalidate);
            params.sink.set_params(handles.clone(), armed);
            refresh_params(&handles, params.reg, params.state_ptr, position);
            rebound.push(DeviceParams {
                device_uuid: params.device_uuid, reg: params.reg, state_ptr: params.state_ptr,
                sink: params.sink, paths: params.paths, handles, field_subs, collections,
                observe_subs: params.observe_subs, // a re-bind doesn't touch the plain field observations
                sidechain_paths: params.sidechain_paths // nor the declared sidechain paths (an automation rebind is not a rewire)
            });
        }
        wired.device_params = rebound;
        unit.wired = Some(wired);
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
    let region_sub = graph.subscribe_pointer_hub(Address::of(track_uuid, vec![3]), Box::new(move |_graph, event| {
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
const VALUE_REGION_TRACK_KEY: u16 = 1;  // ValueRegionBox.regions -> the track's region collection
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
/// with their `events` collection and span (position 10, duration 11, loopOffset 12, loopDuration 13).
fn value_regions_of_track(graph: &BoxGraph, track_uuid: Uuid) -> Vec<RegionSpec> {
    let mut specs = Vec::new();
    for region in graph.find_all_by_name("ValueRegionBox") {
        let on_track = graph.target_of(&Address::of(region.uuid, vec![VALUE_REGION_TRACK_KEY]))
            .map(|address| address.uuid) == Some(track_uuid);
        if !on_track {
            continue;
        }
        if let Some(collection) = graph.target_of(&Address::of(region.uuid, vec![VALUE_REGION_EVENTS_KEY])).map(|address| address.uuid) {
            specs.push(RegionSpec {
                collection,
                position: region_pulses(graph, region.uuid, 10),
                duration: region_pulses(graph, region.uuid, 11),
                loop_offset: region_pulses(graph, region.uuid, 12),
                loop_duration: region_pulses(graph, region.uuid, 13)
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
}
