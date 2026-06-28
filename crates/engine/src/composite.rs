//! Composite devices: a device box that, instead of being a single leaf DSP, HOSTS a child collection of its
//! own instruments (e.g. Playfield's sample slots), each with its own chains, summed into one output. This is
//! the engine-side, GENERIC mechanism — it learns a composite only as a registered `CompositeSpec` (its child
//! collection's host field + index key); no box name or field key is hardcoded here. Playfield is just one
//! registration.
//!
//! A composite is built recursively: each child is realized by its OWN box type through `build_instrument`,
//! which dispatches a leaf voice device to `build_cluster` (the shared leaf builder in `audio_unit`) or a
//! nested composite back to `build_composite`. So a composite may contain composites, with no special case.
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
use core::cell::RefCell;
use abi::DEVICE_KIND_INSTRUMENT;
use bindings::indexed_collection::IndexedCollection;
use boxgraph::address::{Address, Uuid};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_sequencer::NoteSequencer;
use crate::audio_unit::{BoundNoteRegions, BuiltCluster, DeviceParams, SharedTrackSets, SidechainBinding};
use crate::{CompositeSpec, Engine, PullLink, EFFECT_INDEX_KEY};

/// A composite's PERSISTENT per-child cascade, owned by the unit whose instrument is the composite. Each child
/// (a Playfield slot etc.) keeps its own processors across reconciles — a child add / remove / reorder creates
/// only the joiner, terminates only the leaver, and keeps the survivors (and their voices), exactly like the
/// leaf `AudioDeviceChain`, one level down. The children sum into one bus (`sum`); the owning unit appends its
/// channel strip after the sum. `sum` / `sum_buffer` / `sum_id` persist across child edits, so the unit's tail
/// (strip -> master) is never disturbed.
pub(crate) struct CompositeBinding {
    spec: CompositeSpec,
    children: IndexedCollection,            // the child-slot membership (host = `spec.children_field`)
    pub(crate) sum: Rc<RefCell<AudioBusProcessor>>,
    pub(crate) sum_id: NodeId,
    pub(crate) sum_buffer: SharedAudioBuffer,
    members: Vec<CompositeChild>            // persistent per-child records, in sum order
}

/// One persistent composite child: its built cluster (kept across reconciles so its DSP state survives), its
/// own fx-chain observations, its choke set (to detect a choke-context change), and an optional nested
/// composite. `edges` includes the child's internal edges AND its sum edge, so teardown removes them together.
struct CompositeChild {
    uuid: Uuid,
    choke: Vec<i32>,
    chains: Vec<IndexedCollection>,
    nested: Option<CompositeBinding>,
    output: SharedAudioBuffer,              // the child's output buffer, summed into the bus; removed on teardown
    nodes: Vec<NodeId>,                     // the child's processor nodes; `nodes[0]` is its instrument
    edges: Vec<(NodeId, NodeId)>,           // its internal edges AND its sum edge
    device_params: Vec<DeviceParams>,
    sidechains: Vec<SidechainBinding>
}

impl CompositeBinding {
    /// The first (instrument) node of a child, by uuid — for tests / introspection.
    #[cfg(test)]
    pub(crate) fn child_instrument_node(&self, uuid: Uuid) -> Option<NodeId> {
        self.members.iter().find(|child| child.uuid == uuid).and_then(|child| child.nodes.first().copied())
    }

    /// Visit every device's bound parameters in this composite (recursing into nested composites), so the unit
    /// can re-bind automation across the whole cascade.
    pub(crate) fn for_each_params(&mut self, visit: &mut dyn FnMut(&mut DeviceParams)) {
        for child in &mut self.members {
            for params in &mut child.device_params {
                visit(params);
            }
            if let Some(nested) = &mut child.nested {
                nested.for_each_params(visit);
            }
        }
    }

    /// Visit every sidechain binding in this composite (recursing into nested composites), so the unit can
    /// re-resolve sidechains across the whole cascade.
    pub(crate) fn for_each_sidechain(&mut self, visit: &mut dyn FnMut(&mut SidechainBinding)) {
        for child in &mut self.members {
            for binding in &mut child.sidechains {
                visit(binding);
            }
            if let Some(nested) = &mut child.nested {
                nested.for_each_sidechain(visit);
            }
        }
    }
}

/// The choke group a child receives: every OTHER exclude child's note. A non-exclude child gets none (it sees
/// the full stream and filters its own note). Recomputed each reconcile so a membership change re-chokes
/// siblings.
fn choke_for(infos: &[(Uuid, Option<i32>, bool)], index: Option<i32>, exclude: bool) -> Vec<i32> {
    if !exclude {
        return Vec::new();
    }
    infos.iter().filter(|(_, _, other)| *other).filter_map(|(_, note, _)| *note)
        .filter(|note| Some(*note) != index).collect()
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
        let mut binding = CompositeBinding {spec: spec.clone(), children, sum, sum_id, sum_buffer, members: Vec::new()};
        self.reconcile_composite_children(&mut binding, track_sets, signal, invalidate);
        binding
    }

    /// Per-child reconcile (mirrors the leaf `reconcile_leaf`, one level down): diff the child collection
    /// against the persistent members, KEEP unchanged survivors (their voices live on), build only joiners,
    /// terminate only leavers, and rebuild a child whose own fx chain, nested subtree, or choke context
    /// changed. The sum bus persists, so the unit's strip tail is never touched. A no-op when nothing changed.
    pub(crate) fn reconcile_composite_children(&mut self, binding: &mut CompositeBinding, track_sets: &SharedTrackSets,
                                               signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        binding.children.take_dirty(); // consume the membership flag
        let spec = binding.spec.clone();
        let desired = binding.children.sorted();
        let infos = self.child_infos(&desired, &spec);
        let mut pool: BTreeMap<Uuid, CompositeChild> = binding.members.drain(..).map(|child| (child.uuid, child)).collect();
        let mut members: Vec<CompositeChild> = Vec::new();
        for (uuid, index, exclude) in &infos {
            let choke = choke_for(&infos, *index, *exclude);
            // Reuse the survivor only if its own chains / nested subtree are clean AND its choke context is
            // unchanged; otherwise rebuild that one child (its voice resets, but no sibling is touched).
            let reuse = match pool.get(uuid) {
                Some(child) => child.choke == choke && !self.child_changed(child),
                None => false
            };
            if reuse {
                members.push(pool.remove(uuid).expect("pooled survivor"));
            } else {
                if let Some(stale) = pool.remove(uuid) {
                    binding.sum.borrow_mut().remove_audio_source(&stale.output); // stop summing the rebuilt child
                    self.teardown_child(stale);
                }
                if let Some(child) = self.build_one_child(binding.sum.clone(), binding.sum_id, track_sets, *uuid, choke, &spec, signal, invalidate) {
                    members.push(child);
                }
            }
        }
        for (_, stale) in pool { // whatever is left did not return: a leaver
            binding.sum.borrow_mut().remove_audio_source(&stale.output); // stop summing the removed child (else its stale buffer keeps mixing)
            self.teardown_child(stale);
        }
        binding.members = members;
    }

    /// Read each child's routing note (`index_key`) and choke-group flag (`exclude_key`) once. `index_key` 0
    /// means no routing (every child full); `exclude_key` 0 means no choke groups.
    fn child_infos(&self, child_uuids: &[Uuid], spec: &CompositeSpec) -> Vec<(Uuid, Option<i32>, bool)> {
        child_uuids.iter().map(|&uuid| {
            let index = if spec.index_key == 0 { None } else {
                self.graph.field_value(&Address::of(uuid, vec![spec.index_key])).and_then(|value| value.as_int32())
            };
            let exclude = spec.exclude_key != 0
                && self.graph.field_value(&Address::of(uuid, vec![spec.exclude_key])).and_then(|value| value.as_bool()).unwrap_or(false);
            (uuid, index, exclude)
        }).collect()
    }

    /// Whether a survivor child must be rebuilt: its own fx chain changed or its nested subtree changed.
    /// Consumes the flags at every level (no short-circuit) so one dirty does not mask another.
    fn child_changed(&self, child: &CompositeChild) -> bool {
        let mut changed = false;
        for chain in &child.chains {
            changed |= chain.take_dirty();
        }
        if let Some(nested) = &child.nested {
            changed |= self.composite_dirty(nested);
        }
        changed
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

    /// Build one persistent child: dispatch to a cell wrapper or the direct child box, register its output (so
    /// a sidechain can point at it), and wire it into the sum. The sum edge is stored with the child so
    /// teardown removes it. `None` if the child has no plugin / composite (silently skipped).
    fn build_one_child(&mut self, sum: Rc<RefCell<AudioBusProcessor>>, sum_id: NodeId, track_sets: &SharedTrackSets,
                       child_uuid: Uuid, choke: Vec<i32>, spec: &CompositeSpec, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>)
        -> Option<CompositeChild> {
        let cell_based = spec.cell_instrument_field != 0;
        let (cluster, chains, nested) = if cell_based {
            self.build_cell(track_sets, child_uuid, spec, signal, invalidate)?
        } else {
            self.build_instrument(track_sets, child_uuid, Rc::from(choke.clone()), signal, invalidate)?
        };
        self.refresh_joiner_params(&cluster.device_params); // push this joiner child's initial parameter values
        self.output_registry.register(Address::of(child_uuid, vec![]), cluster.output.clone(), cluster.output_node);
        sum.borrow_mut().add_audio_source(cluster.output.clone());
        self.context.register_edge(cluster.output_node, sum_id);
        let mut edges = cluster.edges;
        edges.push((cluster.output_node, sum_id)); // the sum edge, torn down with the child
        Some(CompositeChild {
            uuid: child_uuid, choke, chains, nested, output: cluster.output,
            nodes: cluster.nodes, edges, device_params: cluster.device_params, sidechains: cluster.sidechains
        })
    }

    /// Terminate ONE child (a leaver or a rebuilt child): unregister its output, remove its edges (incl. the
    /// sum edge) + nodes, unsubscribe its fx-chain observations + sidechain monitors, drop its params, and
    /// recurse into a nested composite.
    fn teardown_child(&mut self, child: CompositeChild) {
        self.output_registry.remove(&Address::of(child.uuid, vec![]));
        for (source, target) in &child.edges {
            self.context.remove_edge(*source, *target);
        }
        for node in &child.nodes {
            self.context.remove_processor(*node);
        }
        for chain in child.chains {
            chain.terminate(&mut self.graph);
        }
        for binding in child.sidechains {
            for port in binding.ports {
                self.graph.unsubscribe(port.pointer_sub);
            }
        }
        self.teardown_device_params(child.device_params);
        if let Some(nested) = child.nested {
            self.teardown_composite(nested);
        }
    }

    /// Terminate a whole composite (the unit's instrument changed, or the unit is removed): every child, the
    /// sum node, and the child-collection observation.
    pub(crate) fn teardown_composite(&mut self, binding: CompositeBinding) {
        for child in binding.members {
            self.teardown_child(child);
        }
        self.context.remove_processor(binding.sum_id);
        binding.children.terminate(&mut self.graph);
    }

    /// Build one child instrument node for `box_uuid`, dispatching on its OWN box type: a nested composite
    /// (recurse) or a leaf voice device. A leaf reads the unit's regions through its own sequencer, then folds
    /// its OWN midi / audio fx chains on top. The fx-host field keys are declared by the child DEVICE itself
    /// (`DeviceReg.midi_effects_field` / `audio_effects_field`), so different child instruments may host their
    /// chains at different keys and nothing box-specific is hardcoded here. Returns the cluster, the leaf's
    /// fx-chain observations (empty for a nested composite), and an optional nested cascade, or `None` if the
    /// box has no plugin / composite spec (silently skipped).
    fn build_instrument(&mut self, track_sets: &SharedTrackSets, box_uuid: Uuid, choke: Rc<[i32]>, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>)
        -> Option<(BuiltCluster, Vec<IndexedCollection>, Option<CompositeBinding>)> {
        let name = self.graph.find_box(&box_uuid)?.name.clone();
        if let Some(spec) = self.composite_for_type(&name) {
            // A nested composite routes its own children internally, so it takes the full stream here. It owns
            // its nodes / edges / params / sidechains; the parent only needs its sum output to wire + sum.
            let binding = self.build_composite(track_sets, box_uuid, &spec, signal, invalidate);
            let cluster = BuiltCluster {
                output: binding.sum_buffer.clone(), output_node: binding.sum_id,
                nodes: Vec::new(), edges: Vec::new(), device_params: Vec::new(), sidechains: Vec::new()
            };
            return Some((cluster, Vec::new(), Some(binding)));
        }
        let device = self.device_for_type(&name).filter(|device| device.kind == DEVICE_KIND_INSTRUMENT)?;
        let sequencer: SharedNoteEventSource =
            Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: track_sets.clone()}))));
        // EVERY child gets the full broadcast stream and filters its own note itself (a Playfield slot by its
        // observed `index`; a full instrument filters nothing and plays all). A child in a choke group also gets
        // its sibling chokes injected.
        let source = if choke.is_empty() {
            PullLink::Source(sequencer)
        } else {
            PullLink::SlotRoute {upstream: sequencer, choke}
        };
        // The child's OWN fx chains: observe its midi / audio effect host collections at the field keys the
        // device declares, ordered like a unit's chains by EFFECT_INDEX_KEY. The observations go to the binding
        // so a live add / remove of a child effect re-dirties the unit. A device that hosts no chains (key 0)
        // observes nothing and folds no fx.
        let mut chains = Vec::new();
        let midi = self.observe_child_chain(box_uuid, device.midi_effects_field, &mut chains, signal);
        let audio = self.observe_child_chain(box_uuid, device.audio_effects_field, &mut chains, signal);
        let cluster = self.build_cluster(source, box_uuid, device, &midi, &audio, signal, invalidate);
        Some((cluster, chains, None))
    }

    /// Observe one of a child's fx-host collections (`field` = the device-declared host key, 0 = the device
    /// hosts no chain there) and return its members sorted by `EFFECT_INDEX_KEY`. A live observation is pushed
    /// to `chains` for the binding's reactivity / teardown; key 0 yields an empty chain and no observation.
    fn observe_child_chain(&mut self, box_uuid: Uuid, field: u16, chains: &mut Vec<IndexedCollection>, signal: &Rc<dyn Fn()>) -> Vec<Uuid> {
        if field == 0 {
            return Vec::new();
        }
        let observation = IndexedCollection::observe(&mut self.graph, Address::of(box_uuid, vec![field]), EFFECT_INDEX_KEY);
        let sorted = observation.sorted();
        observation.take_dirty();
        observation.set_on_dirty(signal.clone()); // a live add / remove of a child effect enqueues the owning unit
        chains.push(observation);
        sorted
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
            Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: track_sets.clone()}))));
        let mut chains = vec![instrument_obs];
        let midi = self.observe_child_chain(cell_uuid, spec.cell_midi_field, &mut chains, signal);
        let audio = self.observe_child_chain(cell_uuid, spec.cell_audio_field, &mut chains, signal);
        let cluster = self.build_cluster(PullLink::Source(sequencer), instrument_uuid, device, &midi, &audio, signal, invalidate);
        Some((cluster, chains, None))
    }
}
