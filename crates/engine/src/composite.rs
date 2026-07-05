//! Composite devices: a device box that, instead of being a single leaf DSP, HOSTS a child collection of its
//! own instruments (e.g. Playfield's sample slots), each with its own chains, summed into one output. This is
//! the engine-side, GENERIC mechanism — it learns a composite only as a registered `CompositeSpec` (its child
//! collection's host field + index key); no box name or field key is hardcoded here. Playfield is just one
//! registration.
//!
//! A composite is built recursively: `build_one_child` realizes each child by its OWN box type — a direct
//! instrument slot becomes an edge-only `SlotCluster` (reconciled in place, like a leaf unit), a cell becomes a
//! wholesale cluster (`build_cluster`), and a nested composite recurses through `build_composite`. So a composite
//! may contain composites, with no special case.
//!
//! The `CompositeBinding` is the PERSISTENT per-child cascade the owning unit keeps: the child-collection
//! observation plus one record per child (its processors, fx-chain observations, choke set, nested cascade).
//! A child add / remove / reorder is reconciled PER CHILD (`reconcile_composite_children`) — only the joiner is
//! built, only the leaver torn down, survivors keep their voices — exactly like the leaf `AudioDeviceChain`,
//! one level down.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::DEVICE_KIND_INSTRUMENT;
use bindings::indexed_collection::IndexedCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::subscription::{Propagation, SubscriptionId};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_sequencer::NoteSequencer;
use crate::audio_unit::{BoundNoteTracks, BuiltCluster, DeviceParams, SharedTrackSets, SidechainBinding, SlotCluster};
use crate::{CompositeSpec, DeviceReg, Engine, PullLink, EFFECT_INDEX_KEY};

/// A composite's PERSISTENT per-child cascade, owned by the unit whose instrument is the composite. Each child
/// (a Playfield slot etc.) keeps its own processors across reconciles — a child add / remove / reorder creates
/// only the joiner, terminates only the leaver, and keeps the survivors (and their voices), exactly like the
/// leaf `AudioDeviceChain`, one level down. The children sum into one bus (`sum`); the owning unit appends its
/// channel strip after the sum. `sum` / `sum_buffer` / `sum_id` persist across child edits, so the unit's tail
/// (strip -> master) is never disturbed.
pub(crate) struct CompositeBinding {
    spec: CompositeSpec,
    composite_uuid: Uuid,                   // the composite DEVICE box, whose `enabled` gates the whole sum
    children: IndexedCollection,            // the child-slot membership (host = `spec.children_field`)
    pub(crate) sum: Rc<RefCell<AudioBusProcessor>>,
    pub(crate) sum_id: NodeId,
    pub(crate) sum_buffer: SharedAudioBuffer,
    members: Vec<CompositeChild>            // persistent per-child records, in sum order
}

impl CompositeBinding {
    /// Collect the live-note injection targets: every SLOT's sequencer (its device filters by pad note),
    /// recursing into nested composites. A CELL's sequencer lives inside its pull link (unreachable here),
    /// so cell composites do not receive live notes yet.
    pub(crate) fn collect_note_sources(&self, out: &mut Vec<SharedNoteEventSource>) {
        for child in &self.members {
            match &child.body {
                ChildBody::Slot {cluster, ..} => out.push(cluster.note_source()),
                ChildBody::Nested {binding} => binding.collect_note_sources(out),
                ChildBody::Cell {..} => {}
            }
        }
    }
}

/// What a composite child IS. A direct-instrument child (e.g. a Playfield slot) is an edge-only `SlotCluster`
/// reconciled in place (its fx-chain edits + effect `enabled` toggles keep every survivor's DSP state). A cell
/// child and a nested composite are rebuilt wholesale (rarer; no edge-only path).
#[allow(clippy::large_enum_variant)] // Slot is the common variant; boxing it would add a per-slot heap allocation
enum ChildBody {
    Slot {cluster: SlotCluster, device: DeviceReg, midi_obs: Option<IndexedCollection>, audio_obs: Option<IndexedCollection>},
    Cell {chains: Vec<IndexedCollection>, nodes: Vec<NodeId>, edges: Vec<(NodeId, NodeId)>, device_params: Vec<DeviceParams>, sidechains: Vec<SidechainBinding>},
    Nested {binding: CompositeBinding}
}

/// One persistent composite child: its body (kept across reconciles so DSP state survives), its choke set (to
/// detect a choke-context change), whether it is currently summed, and its `enabled` monitor. `output` /
/// `output_node` is what feeds the bus; `effects_dirty` is the slot's re-wire flag (a member `enabled` toggle).
struct CompositeChild {
    uuid: Uuid,
    choke: Vec<i32>,
    body: ChildBody,
    output: SharedAudioBuffer,              // the child's output buffer, summed into the bus
    output_node: NodeId,                    // the node feeding the sum (sum edge: output_node -> sum_id)
    summed: bool,                           // whether `output` is currently a source of the sum (false = disabled)
    enabled_sub: Option<SubscriptionId>,    // monitor on the child's OWN `enabled` field (None if unsupported)
    effects_dirty: Rc<Cell<bool>>,          // set by a slot member's `enabled` toggle -> reconcile this slot
    gate: Rc<Cell<bool>>,                   // the child's SILENT flag (mute / not-soloed), read by its pull route
    gate_subs: Vec<SubscriptionId>          // monitors on the child's `mute` / `solo` fields (empty if unsupported)
}

/// Sync a child's sum membership to its `enabled`: add its output as a source when it should be summed but is
/// not, remove it when it should not be but is. Returns the new `summed` state. The one bypass invariant, shared
/// by the build / slot-reconcile / wholesale-reconcile paths.
fn sync_sum(sum: &Rc<RefCell<AudioBusProcessor>>, output: &SharedAudioBuffer, summed: bool, enabled: bool) -> bool {
    if enabled && !summed {
        sum.borrow_mut().add_audio_source(output.clone());
    } else if !enabled && summed {
        sum.borrow_mut().remove_audio_source(output);
    }
    enabled
}

/// Whether a slot's own fx chains or a member `enabled` toggle changed, consuming every flag (no short-circuit,
/// so one dirty does not mask another). Shared by the in-place reconcile and the nested-subtree dirty check.
fn slot_obs_dirty(midi_obs: &Option<IndexedCollection>, audio_obs: &Option<IndexedCollection>, effects_dirty: &Cell<bool>) -> bool {
    midi_obs.as_ref().is_some_and(|obs| obs.take_dirty())
        | audio_obs.as_ref().is_some_and(|obs| obs.take_dirty())
        | effects_dirty.replace(false)
}

impl CompositeBinding {
    #[cfg(test)]
    fn find(&self, uuid: Uuid) -> Option<&CompositeChild> {
        self.members.iter().find(|child| child.uuid == uuid)
    }

    /// The instrument node of a child, by uuid — for tests / introspection.
    #[cfg(test)]
    pub(crate) fn child_instrument_node(&self, uuid: Uuid) -> Option<NodeId> {
        self.find(uuid).and_then(|child| match &child.body {
            ChildBody::Slot {cluster, ..} => Some(cluster.instrument_node()),
            ChildBody::Cell {nodes, ..} => nodes.first().copied(),
            ChildBody::Nested {..} => None
        })
    }

    /// How many audio-fx members a slot child OWNS (built + persistent, incl. a disabled one).
    #[cfg(test)]
    pub(crate) fn child_audio_member_count(&self, uuid: Uuid) -> Option<usize> {
        self.find(uuid).and_then(|child| match &child.body {
            ChildBody::Slot {cluster, ..} => Some(cluster.audio_member_count()),
            _ => None
        })
    }

    /// How many audio-fx of a slot child are currently WIRED (a disabled one is bypassed but still owned).
    #[cfg(test)]
    pub(crate) fn child_wired_audio_count(&self, uuid: Uuid) -> Option<usize> {
        self.find(uuid).and_then(|child| match &child.body {
            ChildBody::Slot {cluster, ..} => Some(cluster.wired_audio_count()),
            _ => None
        })
    }

    /// Visit every device's bound parameters in this composite (recursing into nested composites), so the unit
    /// can re-bind automation across the whole cascade.
    pub(crate) fn for_each_params(&mut self, visit: &mut dyn FnMut(&mut DeviceParams)) {
        for child in &mut self.members {
            match &mut child.body {
                ChildBody::Slot {cluster, ..} => cluster.for_each_params(visit),
                ChildBody::Cell {device_params, ..} => for params in device_params.iter_mut() { visit(params); },
                ChildBody::Nested {binding} => binding.for_each_params(visit)
            }
        }
    }

    /// Visit every sidechain binding in this composite (recursing into nested composites), so the unit can
    /// re-resolve sidechains across the whole cascade.
    pub(crate) fn for_each_sidechain(&mut self, visit: &mut dyn FnMut(&mut SidechainBinding)) {
        for child in &mut self.members {
            match &mut child.body {
                ChildBody::Slot {cluster, ..} => cluster.for_each_sidechain(visit),
                ChildBody::Cell {sidechains, ..} => for binding in sidechains.iter_mut() { visit(binding); },
                ChildBody::Nested {binding} => binding.for_each_sidechain(visit)
            }
        }
    }
}

/// One child's reconcile-time facts, read from the graph each pass: its routing note, its choke-group flag,
/// whether it is SILENT (muted, or not soloed while a sibling is — TS `SampleProcessor.handleEvent`), and
/// whether it OWNS its routing note (TS routes a note to exactly ONE pad per index — see `route_owners`).
#[derive(Clone, Copy)]
pub(crate) struct ChildInfo {
    uuid: Uuid,
    index: Option<i32>,
    exclude: bool,
    silent: bool,
    route_owner: bool
}

/// Mark, per child, whether it receives its index's notes: TS `PlayfieldDeviceProcessor.optSampleProcessor`
/// resolves a note via `getAdapterByIndex` — a MIDPOINT binary search over the pads sorted by (index, then
/// uuid: a stable sort over the uuid-ordered set) — so of several children sharing an index exactly ONE (the
/// search's pick) plays; the others get no events at all. Mirror the exact search so the pick matches TS.
fn route_owners(infos: &mut [ChildInfo]) {
    let mut sorted: Vec<(i32, Uuid)> = infos.iter()
        .filter_map(|info| info.index.map(|index| (index, info.uuid))).collect();
    sorted.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let owner_of = |key: i32| -> Option<Uuid> {
        let mut low: isize = 0;
        let mut high: isize = sorted.len() as isize - 1;
        while low <= high {
            let mid = ((low + high) >> 1) as usize;
            match sorted[mid].0.cmp(&key) {
                core::cmp::Ordering::Equal => return Some(sorted[mid].1),
                core::cmp::Ordering::Less => low = mid as isize + 1,
                core::cmp::Ordering::Greater => high = mid as isize - 1
            }
        }
        None
    };
    for info in infos.iter_mut() {
        info.route_owner = match info.index {
            Some(index) => owner_of(index) == Some(info.uuid),
            None => true // no routing: every child sees the full stream
        };
    }
}

/// The choke group a child receives: every OTHER exclude child's note. A non-exclude child gets none (it sees
/// the full stream and filters its own note). A SILENT or non-route-owner sibling does not choke (TS returns
/// before `stopExcludeOthers` when the pad is muted / not soloed, and a non-owner pad never starts a voice).
/// Recomputed each reconcile so a membership, mute, or solo change re-chokes siblings.
fn choke_for(infos: &[ChildInfo], index: Option<i32>, exclude: bool) -> Vec<i32> {
    if !exclude {
        return Vec::new();
    }
    infos.iter().filter(|other| other.exclude && !other.silent && other.route_owner)
        .filter_map(|other| other.index)
        .filter(|note| Some(*note) != index).collect()
}

/// The re-wire signal a SLOT's members fire when their `enabled` toggles: mark the slot dirty + enqueue the unit,
/// so `reconcile_one_child` re-wires that slot EDGE-ONLY (bypass / restore the toggled effect), no sibling touched.
fn slot_rewire(effects_dirty: &Rc<Cell<bool>>, signal: &Rc<dyn Fn()>) -> Rc<dyn Fn()> {
    let dirty = effects_dirty.clone();
    let signal = signal.clone();
    Rc::new(move || { dirty.set(true); signal(); })
}

impl Engine {
    /// Build a composite: observe the child collection (`spec.children_field`, ordered by `spec.index_key`),
    /// create the summing bus, and build one persistent child per member. Returns the `CompositeBinding` the
    /// unit stores (its `sum_buffer` / `sum_id` are the cluster output the unit's strip reads). Generic over
    /// any composite — the only composite-specific input is `spec`.
    pub(crate) fn build_composite(&mut self, track_sets: &SharedTrackSets, composite_uuid: Uuid, spec: &CompositeSpec, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>)
        -> CompositeBinding {
        let children = IndexedCollection::observe(&mut self.graph,
            Address::of(composite_uuid, vec![spec.children_field]), spec.index_key);
        children.set_on_dirty(signal.clone()); // a later child add / remove / reorder enqueues the owning unit
        let sum_buffer = shared_audio_buffer();
        let sum = Rc::new(RefCell::new(AudioBusProcessor::new(sum_buffer.clone())));
        let sum_id = self.context.register_processor(sum.clone());
        self.context.set_label(sum_id, alloc::string::String::from("composite-sum"));
        let mut binding = CompositeBinding {spec: spec.clone(), composite_uuid, children, sum, sum_id, sum_buffer, members: Vec::new()};
        self.reconcile_composite_children(&mut binding, track_sets, signal, invalidate);
        binding
    }

    /// Per-child reconcile (mirrors the leaf `reconcile_leaf`, one level down): diff the child collection against
    /// the persistent members, build only joiners, terminate only leavers, and reconcile each survivor IN PLACE.
    /// A direct-instrument SLOT child re-wires EDGE-ONLY (its fx-chain edits + effect `enabled` toggles keep every
    /// survivor's DSP state); a cell / nested child rebuilds wholesale. The sum bus persists, so the unit's strip
    /// tail is never touched.
    pub(crate) fn reconcile_composite_children(&mut self, binding: &mut CompositeBinding, track_sets: &SharedTrackSets,
                                               signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        binding.children.take_dirty(); // consume the membership flag
        let spec = binding.spec.clone();
        let desired = binding.children.sorted();
        let infos = self.child_infos(&desired, &spec);
        let mut pool: BTreeMap<Uuid, CompositeChild> = binding.members.drain(..).map(|child| (child.uuid, child)).collect();
        let mut members: Vec<CompositeChild> = Vec::new();
        for info in &infos {
            let choke = choke_for(&infos, info.index, info.exclude);
            let reconciled = match pool.remove(&info.uuid) {
                Some(child) => self.reconcile_one_child(binding, child, choke, &spec, track_sets, signal, invalidate),
                None => self.build_one_child(binding.sum.clone(), binding.sum_id, track_sets, info.uuid, choke, &spec, signal, invalidate)
            };
            if let Some(child) = reconciled {
                // Resolved across all siblings (solo + index ownership are cross-child facts), so it lands
                // AFTER every read: silent (mute / not-soloed) or not this index's route owner = no starts.
                child.gate.set(info.silent || !info.route_owner);
                members.push(child);
            }
        }
        for (_, stale) in pool { // whatever is left did not return: a leaver
            self.detach_child_sum(binding, &stale);
            self.teardown_child(stale);
        }
        binding.members = members;
        // Apply the composite DEVICE's `enabled`: a disabled composite (e.g. Playfield) silences its whole sum,
        // edge-only — children keep their state. Re-applied each reconcile so an `enabled` toggle (which enqueues
        // the unit WITHOUT a chain change, landing here, not the wholesale `reconcile_composite`) takes effect.
        binding.sum.borrow_mut().set_enabled(self.device_enabled(binding.composite_uuid));
    }

    /// Reconcile ONE surviving child in place. A SLOT (direct instrument) re-wires its cluster edge-only when its
    /// fx chain, choke, or a member `enabled` changed (survivors keep their DSP state); then its sum membership is
    /// synced to its own `enabled`. A CELL / NESTED child rebuilds wholesale if its subtree changed, else just
    /// syncs its sum membership. Returns the reconciled child (always `Some`, except a wholesale rebuild that finds
    /// the child no longer buildable).
    #[allow(clippy::too_many_arguments)] // threads the reconcile cascade context
    fn reconcile_one_child(&mut self, binding: &mut CompositeBinding, child: CompositeChild, choke: Vec<i32>,
                           spec: &CompositeSpec, track_sets: &SharedTrackSets, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) -> Option<CompositeChild> {
        let CompositeChild {uuid, choke: old_choke, body, output, output_node, summed, enabled_sub, effects_dirty, gate, gate_subs} = child;
        let choke_changed = old_choke != choke;
        match body {
            ChildBody::Slot {cluster, device, midi_obs, audio_obs} => {
                let dirty = slot_obs_dirty(&midi_obs, &audio_obs, &effects_dirty) | choke_changed;
                let (cluster, output, output_node, summed) = if dirty {
                    // Edge-only re-wire: drop the old sum wiring, reconcile the cluster (reusing survivors), re-wire.
                    if summed { binding.sum.borrow_mut().remove_audio_source(&output); }
                    self.context.remove_edge(output_node, binding.sum_id);
                    let midi_uuids = midi_obs.as_ref().map(|obs| obs.sorted()).unwrap_or_default();
                    let audio_uuids = audio_obs.as_ref().map(|obs| obs.sorted()).unwrap_or_default();
                    let rewire = slot_rewire(&effects_dirty, signal);
                    let cluster = self.reconcile_slot_cluster(Some(cluster), uuid, device, &midi_uuids, &audio_uuids, track_sets, &choke, &gate, signal, invalidate, &rewire);
                    self.context.register_edge(cluster.output_node, binding.sum_id);
                    self.output_registry.register(Address::of(uuid, vec![]), cluster.output.clone(), cluster.output_node);
                    let (output, output_node) = (cluster.output.clone(), cluster.output_node);
                    (cluster, output, output_node, false) // source was removed; re-added below per `enabled`
                } else {
                    (cluster, output, output_node, summed)
                };
                let summed = sync_sum(&binding.sum, &output, summed, self.child_enabled(uuid, spec.child_enabled_key));
                Some(CompositeChild {uuid, choke, body: ChildBody::Slot {cluster, device, midi_obs, audio_obs},
                    output, output_node, summed, enabled_sub, effects_dirty, gate, gate_subs})
            }
            ChildBody::Cell {chains, nodes, edges, device_params, sidechains} => {
                let dirty = chains.iter().fold(false, |acc, chain| acc | chain.take_dirty()) | choke_changed;
                let child = CompositeChild {uuid, choke: if dirty {choke.clone()} else {choke},
                    body: ChildBody::Cell {chains, nodes, edges, device_params, sidechains},
                    output, output_node, summed, enabled_sub, effects_dirty, gate, gate_subs};
                self.reconcile_wholesale_child(binding, child, dirty, spec, track_sets, signal, invalidate)
            }
            ChildBody::Nested {binding: nested} => {
                let dirty = self.composite_dirty(&nested) | choke_changed;
                let child = CompositeChild {uuid, choke: if dirty {choke.clone()} else {choke},
                    body: ChildBody::Nested {binding: nested},
                    output, output_node, summed, enabled_sub, effects_dirty, gate, gate_subs};
                self.reconcile_wholesale_child(binding, child, dirty, spec, track_sets, signal, invalidate)
            }
        }
    }

    /// A cell / nested child: rebuild wholesale if its subtree changed (its voice resets, but no sibling is
    /// touched), else just sync its sum membership to its own `enabled`.
    #[allow(clippy::too_many_arguments)] // threads the reconcile cascade context
    fn reconcile_wholesale_child(&mut self, binding: &mut CompositeBinding, mut child: CompositeChild, dirty: bool,
                                 spec: &CompositeSpec, track_sets: &SharedTrackSets, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) -> Option<CompositeChild> {
        if dirty {
            let uuid = child.uuid;
            let choke = child.choke.clone();
            self.detach_child_sum(binding, &child);
            self.teardown_child(child);
            return self.build_one_child(binding.sum.clone(), binding.sum_id, track_sets, uuid, choke, spec, signal, invalidate);
        }
        child.summed = sync_sum(&binding.sum, &child.output, child.summed, self.child_enabled(child.uuid, spec.child_enabled_key));
        Some(child)
    }

    /// Drop a child's sum wiring (its source + its `output_node -> sum_id` edge), before a rebuild / teardown.
    fn detach_child_sum(&mut self, binding: &CompositeBinding, child: &CompositeChild) {
        if child.summed {
            binding.sum.borrow_mut().remove_audio_source(&child.output);
        }
        self.context.remove_edge(child.output_node, binding.sum_id);
    }

    /// Read each child's routing note (`index_key`), choke-group flag (`exclude_key`), and SILENT state
    /// (mute / solo keys) once. A key of 0 means the composite does not declare that facet. Silent mirrors TS:
    /// `mute || (anySolo && !solo)`, resolved across the whole sibling set.
    fn child_infos(&self, child_uuids: &[Uuid], spec: &CompositeSpec) -> Vec<ChildInfo> {
        let child_flag = |uuid: &Uuid, key: u16| key != 0
            && self.graph.field_value(&Address::of(*uuid, vec![key])).and_then(|value| value.as_bool()).unwrap_or(false);
        let has_solo = spec.child_solo_key != 0
            && child_uuids.iter().any(|uuid| child_flag(uuid, spec.child_solo_key));
        let mut infos: Vec<ChildInfo> = child_uuids.iter().map(|&uuid| {
            let index = if spec.index_key == 0 { None } else {
                self.graph.field_value(&Address::of(uuid, vec![spec.index_key])).and_then(|value| value.as_int32())
            };
            let exclude = child_flag(&uuid, spec.exclude_key);
            let silent = child_flag(&uuid, spec.child_mute_key)
                || (has_solo && !child_flag(&uuid, spec.child_solo_key));
            ChildInfo {uuid, index, exclude, silent, route_owner: true}
        }).collect();
        route_owners(&mut infos);
        infos
    }

    /// Whether a child contributes to the sum: its `enabled` field at `key` (true when the composite declares no
    /// child-enable key, i.e. `key == 0`).
    fn child_enabled(&self, child_uuid: Uuid, key: u16) -> bool {
        if key == 0 { return true; }
        self.graph.field_value(&Address::of(child_uuid, vec![key])).and_then(|value| value.as_bool()).unwrap_or(true)
    }

    /// A TARGETED `This` monitor on a child's `enabled` field: a toggle enqueues the owning unit (plain `signal`,
    /// not a chain change) so reconcile re-syncs the child's sum membership. `None` when the composite declares
    /// no child-enable key.
    fn subscribe_child_enabled(&mut self, child_uuid: Uuid, key: u16, signal: &Rc<dyn Fn()>) -> Option<SubscriptionId> {
        if key == 0 { return None; }
        let signal = signal.clone();
        Some(self.graph.subscribe_vertex(Propagation::This, Address::of(child_uuid, vec![key]),
            Box::new(move |_graph, _update| signal())))
    }

    /// Whether anything changed in a child's subtree (used only to decide if a NESTED child rebuilds wholesale).
    /// Consumes the flags at every level (no short-circuit) so one dirty does not mask another.
    fn child_changed(&self, child: &CompositeChild) -> bool {
        match &child.body {
            ChildBody::Slot {midi_obs, audio_obs, ..} => slot_obs_dirty(midi_obs, audio_obs, &child.effects_dirty),
            ChildBody::Cell {chains, ..} => chains.iter().fold(false, |acc, chain| acc | chain.take_dirty()),
            ChildBody::Nested {binding} => self.composite_dirty(binding)
        }
    }

    /// Whether anything changed anywhere in a (nested) composite, consuming every flag. A dirty nested subtree
    /// is rebuilt wholesale (nested composites are rare); the TOP composite reconciles per child.
    fn composite_dirty(&self, binding: &CompositeBinding) -> bool {
        let mut dirty = binding.children.take_dirty();
        for child in &binding.members {
            dirty |= self.child_changed(child);
        }
        dirty
    }

    /// Build one persistent child, dispatching on its kind: a DIRECT instrument becomes an edge-only `SlotCluster`
    /// (reconciled in place), a cell becomes a wholesale cluster, a nested composite recurses. Registers its
    /// output (so a sidechain can target it), then wires it into the sum (the source is withheld while disabled).
    /// `None` if the child has no plugin / composite (silently skipped).
    #[allow(clippy::too_many_arguments)] // threads the reconcile cascade context
    fn build_one_child(&mut self, sum: Rc<RefCell<AudioBusProcessor>>, sum_id: NodeId, track_sets: &SharedTrackSets,
                       child_uuid: Uuid, choke: Vec<i32>, spec: &CompositeSpec, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>)
        -> Option<CompositeChild> {
        let effects_dirty = Rc::new(Cell::new(false));
        let gate = Rc::new(Cell::new(false)); // set from the resolved silent state by the caller each reconcile
        let cell_based = spec.cell_instrument_field != 0;
        let (body, output, output_node) = if cell_based {
            let (cluster, chains, _nested) = self.build_cell(track_sets, child_uuid, spec, signal, invalidate)?;
            self.refresh_joiner_params(&cluster.device_params); // push the cell's joiner parameter values
            let (output, output_node) = (cluster.output.clone(), cluster.output_node);
            (ChildBody::Cell {chains, nodes: cluster.nodes, edges: cluster.edges, device_params: cluster.device_params, sidechains: cluster.sidechains}, output, output_node)
        } else {
            let name = self.graph.find_box(&child_uuid)?.name.clone();
            if let Some(nested_spec) = self.composite_for_type(&name) {
                // A nested composite routes its own children internally; the parent only sums its output.
                let binding = self.build_composite(track_sets, child_uuid, &nested_spec, signal, invalidate);
                let (output, output_node) = (binding.sum_buffer.clone(), binding.sum_id);
                (ChildBody::Nested {binding}, output, output_node)
            } else {
                // A direct-instrument slot: the same edge-only per-member cluster as a leaf unit (each member's
                // own `enabled` monitor re-wires THIS slot via `rewire`, so a slot effect toggle is edge-only).
                let device = self.device_for_type(&name).filter(|device| device.kind == DEVICE_KIND_INSTRUMENT)?;
                let midi_obs = self.observe_chain_opt(child_uuid, device.midi_effects_field, signal);
                let audio_obs = self.observe_chain_opt(child_uuid, device.audio_effects_field, signal);
                let midi_uuids = midi_obs.as_ref().map(|obs| obs.sorted()).unwrap_or_default();
                let audio_uuids = audio_obs.as_ref().map(|obs| obs.sorted()).unwrap_or_default();
                let rewire = slot_rewire(&effects_dirty, signal);
                let cluster = self.reconcile_slot_cluster(None, child_uuid, device, &midi_uuids, &audio_uuids, track_sets, &choke, &gate, signal, invalidate, &rewire);
                let (output, output_node) = (cluster.output.clone(), cluster.output_node);
                (ChildBody::Slot {cluster, device, midi_obs, audio_obs}, output, output_node)
            }
        };
        self.output_registry.register(Address::of(child_uuid, vec![]), output.clone(), output_node);
        let summed = sync_sum(&sum, &output, false, self.child_enabled(child_uuid, spec.child_enabled_key));
        self.context.register_edge(output_node, sum_id);
        let enabled_sub = self.subscribe_child_enabled(child_uuid, spec.child_enabled_key, signal);
        // A mute / solo toggle enqueues the owning unit (like `enabled`); the per-child reconcile re-resolves
        // every sibling's silent state (solo is a cross-child fact) and re-chokes.
        let gate_subs: Vec<SubscriptionId> = [spec.child_mute_key, spec.child_solo_key].iter()
            .filter_map(|&key| self.subscribe_child_enabled(child_uuid, key, signal)).collect();
        Some(CompositeChild {uuid: child_uuid, choke, body, output, output_node, summed, enabled_sub, effects_dirty, gate, gate_subs})
    }

    /// Observe one fx-host collection of a child (`field` = the device-declared host key; 0 = none), sorted by
    /// `EFFECT_INDEX_KEY`, with a live dirty signal. `None` for key 0.
    fn observe_chain_opt(&mut self, box_uuid: Uuid, field: u16, signal: &Rc<dyn Fn()>) -> Option<IndexedCollection> {
        if field == 0 {
            return None;
        }
        let observation = IndexedCollection::observe(&mut self.graph, Address::of(box_uuid, vec![field]), EFFECT_INDEX_KEY);
        observation.take_dirty();
        observation.set_on_dirty(signal.clone()); // a live add / remove / reorder of a child effect enqueues the unit
        Some(observation)
    }

    /// Terminate ONE child (a leaver or a rebuilt child): unregister its output, then tear down its body — a SLOT
    /// terminates its cluster + fx observations; a CELL removes its nodes / edges / observations / sidechains and
    /// drops its params; a NESTED recurses. The caller has already removed the child's sum wiring (`detach_child_sum`).
    fn teardown_child(&mut self, child: CompositeChild) {
        if let Some(sub) = child.enabled_sub {
            self.graph.unsubscribe(sub);
        }
        for sub in child.gate_subs {
            self.graph.unsubscribe(sub);
        }
        self.output_registry.remove(&Address::of(child.uuid, vec![]));
        match child.body {
            ChildBody::Slot {cluster, midi_obs, audio_obs, ..} => {
                if let Some(observation) = midi_obs { observation.terminate(&mut self.graph); }
                if let Some(observation) = audio_obs { observation.terminate(&mut self.graph); }
                self.teardown_slot_cluster(cluster);
            }
            ChildBody::Cell {chains, nodes, edges, device_params, sidechains} => {
                for (source, target) in &edges {
                    self.context.remove_edge(*source, *target);
                }
                for node in &nodes {
                    self.context.remove_processor(*node);
                }
                for chain in chains {
                    chain.terminate(&mut self.graph);
                }
                for binding in sidechains {
                    for port in binding.ports {
                        self.graph.unsubscribe(port.pointer_sub);
                    }
                }
                self.teardown_device_params(device_params);
            }
            ChildBody::Nested {binding} => self.teardown_composite(binding)
        }
    }

    /// Terminate a whole composite (the unit's instrument changed, or the unit is removed): every child (after
    /// detaching its sum edge), the sum node, and the child-collection observation.
    pub(crate) fn teardown_composite(&mut self, binding: CompositeBinding) {
        for child in binding.members {
            self.context.remove_edge(child.output_node, binding.sum_id); // the sum edge (the sum node goes next)
            self.teardown_child(child);
        }
        self.context.remove_processor(binding.sum_id);
        binding.children.terminate(&mut self.graph);
    }

    /// Observe one of a child's fx-host collections (`field` = the device-declared host key, 0 = the device
    /// hosts no chain there) and return its members sorted by `EFFECT_INDEX_KEY`. A live observation is pushed
    /// to `chains` for the binding's reactivity / teardown; key 0 yields an empty chain and no observation.
    fn observe_child_chain(&mut self, box_uuid: Uuid, field: u16, chains: &mut Vec<IndexedCollection>, signal: &Rc<dyn Fn()>) -> Vec<Uuid> {
        match self.observe_chain_opt(box_uuid, field, signal) {
            Some(observation) => { let sorted = observation.sorted(); chains.push(observation); sorted }
            None => Vec::new()
        }
    }

    /// Build one CELL child: a generic wrapper (`spec.cell_*` field keys) holding ONE instrument plus its own
    /// midi / audio fx chains, the way an audio unit hosts an instrument and its chains. The instrument and the
    /// effects are unchanged plugins that attach to the cell by their normal `host` pointers, so a leaf device
    /// needs no per-composite knowledge. Reads the cell's hosted instrument (first member of its instrument host)
    /// and folds the cell's chains around it with the shared `build_cluster`, on the full broadcast stream (a
    /// generic composite has no per-cell note routing). Returns `None` for an empty cell or an unresolved /
    /// non-instrument device, unsubscribing whatever it observed.
    fn build_cell(&mut self, track_sets: &SharedTrackSets, cell_uuid: Uuid, spec: &CompositeSpec, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>)
        -> Option<(BuiltCluster, Vec<IndexedCollection>, Option<CompositeBinding>)> {
        let instrument_obs = IndexedCollection::observe(&mut self.graph, Address::of(cell_uuid, vec![spec.cell_instrument_field]), 0);
        instrument_obs.take_dirty();
        instrument_obs.set_on_dirty(signal.clone()); // swapping the cell's hosted instrument enqueues the owning unit
        let instrument_uuid = match instrument_obs.sorted().first().copied() {
            Some(uuid) => uuid,
            None => { instrument_obs.terminate(&mut self.graph); return None; }
        };
        let name = match self.graph.find_box(&instrument_uuid) {
            Some(device_box) => device_box.name.clone(),
            None => { instrument_obs.terminate(&mut self.graph); return None; }
        };
        let device = match self.device_for_type(&name).filter(|device| device.kind == DEVICE_KIND_INSTRUMENT) {
            Some(device) => device,
            None => { instrument_obs.terminate(&mut self.graph); return None; }
        };
        let sequencer: SharedNoteEventSource =
            Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteTracks {tracks: track_sets.clone()}), self.clip_sequencer.clone())));
        let mut chains = vec![instrument_obs];
        let midi = self.observe_child_chain(cell_uuid, spec.cell_midi_field, &mut chains, signal);
        let audio = self.observe_child_chain(cell_uuid, spec.cell_audio_field, &mut chains, signal);
        let cluster = self.build_cluster(PullLink::Source(sequencer), instrument_uuid, device, &midi, &audio, signal, invalidate);
        Some((cluster, chains, None))
    }
}
