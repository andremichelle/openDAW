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
//! The `CompositeBinding` is the cascade the owning unit keeps: the child-collection observation (and any
//! nested ones), so a child add / remove raises `take_dirty` and the unit re-wires. Mirrors how the audio
//! unit keeps its `input` / `midi` / `audio` device-chain collections.

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;
use abi::DEVICE_KIND_INSTRUMENT;
use bindings::indexed_collection::IndexedCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_sequencer::NoteSequencer;
use crate::audio_unit::{BoundNoteRegions, BuiltCluster, SharedTrackSets};
use crate::{CompositeSpec, Engine, PullLink, EFFECT_INDEX_KEY};

/// A composite's reactive cascade, owned by the unit whose instrument is the composite: the child-collection
/// observation plus the bindings of any nested composites. `take_dirty` returns whether the child set (at any
/// depth) changed since the last reconcile; `terminate` unsubscribes the whole tree on rewire / teardown.
pub(crate) struct CompositeBinding {
    children: IndexedCollection,
    chains: Vec<IndexedCollection>, // each leaf child's own midi + audio fx-chain observations, flat
    nested: Vec<CompositeBinding>
}

impl CompositeBinding {
    /// Whether a child was added / removed / reordered at this level, a child's own fx chain changed, OR
    /// anything changed in a nested composite. Consumes the flag at every level (no short-circuit), so one
    /// dirty does not mask another.
    pub(crate) fn take_dirty(&self) -> bool {
        let mut dirty = self.children.take_dirty();
        for chain in &self.chains {
            dirty |= chain.take_dirty();
        }
        for child in &self.nested {
            dirty |= child.take_dirty();
        }
        dirty
    }

    /// Unsubscribe the child collection, every child's fx-chain observations, and every nested composite.
    pub(crate) fn terminate(self, graph: &mut BoxGraph) {
        self.children.terminate(graph);
        for chain in self.chains {
            chain.terminate(graph);
        }
        for child in self.nested {
            child.terminate(graph);
        }
    }
}

impl Engine {
    /// Build a composite: observe the child collection (`spec.children_field`, ordered by `spec.index_key`),
    /// build one child per member, and sum them into one bus. Returns the wired cluster (its `output` is the
    /// sum buffer, `output_node` the sum node, so the caller appends its own tail) plus the `CompositeBinding`
    /// the unit stores for reactivity. Generic over any composite — the only composite-specific input is `spec`.
    pub(crate) fn build_composite(&mut self, track_sets: &SharedTrackSets, composite_uuid: Uuid, spec: &CompositeSpec)
        -> (BuiltCluster, CompositeBinding) {
        let children = IndexedCollection::observe(&mut self.graph,
            Address::of(composite_uuid, vec![spec.children_field]), spec.index_key);
        let child_uuids = children.sorted();
        children.take_dirty(); // consume the catch-up flag: we build from the current members now
        let sum_buffer = shared_audio_buffer();
        let sum = Rc::new(RefCell::new(AudioBusProcessor::new(sum_buffer.clone())));
        let sum_id = self.context.register_processor(sum.clone());
        let mut nodes = vec![sum_id];
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut device_params = Vec::new();
        let mut device_uuids = Vec::new();
        let mut chains = Vec::new();
        let mut nested = Vec::new();
        // Read each child's routing note (`index_key`) and choke-group flag (`exclude_key`) from the box once.
        // The choke group is every exclude child's note, so an exclude child receives a CHOKE when any OTHER
        // exclude child fires. A child with no index gets the whole stream (a full instrument), and `index_key`
        // 0 means the composite has no routing at all (a generic instrument bundle), so every child is full.
        let infos: Vec<(Uuid, Option<i32>, bool)> = child_uuids.iter().map(|&uuid| {
            let index = if spec.index_key == 0 { None } else {
                self.graph.field_value(&Address::of(uuid, vec![spec.index_key])).and_then(|value| value.as_int32())
            };
            let exclude = spec.exclude_key != 0
                && self.graph.field_value(&Address::of(uuid, vec![spec.exclude_key])).and_then(|value| value.as_bool()).unwrap_or(false);
            (uuid, index, exclude)
        }).collect();
        let exclude_notes: Vec<i32> = infos.iter().filter(|(_, _, exclude)| *exclude).filter_map(|(_, index, _)| *index).collect();
        let cell_based = spec.cell_instrument_field != 0;
        for (child_uuid, index, exclude) in infos {
            // The child's choke group is every OTHER exclude child's note (it filters its own note itself).
            let choke: Rc<[i32]> = if exclude {
                Rc::from(exclude_notes.iter().copied().filter(|note| Some(*note) != index).collect::<Vec<i32>>())
            } else {
                Rc::from(Vec::new())
            };
            // A cell-based composite wraps each child in a generic cell (instrument + its own chains); a direct
            // composite builds the child box itself (a leaf voice, e.g. a Playfield slot, with device-declared
            // chains). Both yield the same cluster + chain-observation shape.
            let built = if cell_based {
                self.build_cell(track_sets, child_uuid, spec)
            } else {
                self.build_instrument(track_sets, child_uuid, choke)
            };
            if let Some((child, child_chains, child_binding)) = built {
                sum.borrow_mut().add_audio_source(child.output);
                self.context.register_edge(child.output_node, sum_id);
                edges.push((child.output_node, sum_id));
                nodes.extend(child.nodes);
                edges.extend(child.edges);
                device_params.extend(child.device_params);
                device_uuids.extend(child.device_uuids);
                chains.extend(child_chains);
                if let Some(binding) = child_binding {
                    nested.push(binding);
                }
            }
        }
        (BuiltCluster {output: sum_buffer, output_node: sum_id, nodes, edges, device_params, device_uuids},
         CompositeBinding {children, chains, nested})
    }

    /// Build one child instrument node for `box_uuid`, dispatching on its OWN box type: a nested composite
    /// (recurse) or a leaf voice device. A leaf reads the unit's regions through its own sequencer, then folds
    /// its OWN midi / audio fx chains on top. The fx-host field keys are declared by the child DEVICE itself
    /// (`DeviceReg.midi_effects_field` / `audio_effects_field`), so different child instruments may host their
    /// chains at different keys and nothing box-specific is hardcoded here. Returns the cluster, the leaf's
    /// fx-chain observations (empty for a nested composite), and an optional nested cascade, or `None` if the
    /// box has no plugin / composite spec (silently skipped).
    fn build_instrument(&mut self, track_sets: &SharedTrackSets, box_uuid: Uuid, choke: Rc<[i32]>)
        -> Option<(BuiltCluster, Vec<IndexedCollection>, Option<CompositeBinding>)> {
        let name = self.graph.find_box(&box_uuid)?.name.clone();
        if let Some(spec) = self.composite_for_type(&name) {
            // A nested composite routes its own children internally, so it takes the full stream here.
            let (cluster, binding) = self.build_composite(track_sets, box_uuid, &spec);
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
        let midi = self.observe_child_chain(box_uuid, device.midi_effects_field, &mut chains);
        let audio = self.observe_child_chain(box_uuid, device.audio_effects_field, &mut chains);
        let cluster = self.build_cluster(source, box_uuid, device, &midi, &audio);
        Some((cluster, chains, None))
    }

    /// Observe one of a child's fx-host collections (`field` = the device-declared host key, 0 = the device
    /// hosts no chain there) and return its members sorted by `EFFECT_INDEX_KEY`. A live observation is pushed
    /// to `chains` for the binding's reactivity / teardown; key 0 yields an empty chain and no observation.
    fn observe_child_chain(&mut self, box_uuid: Uuid, field: u16, chains: &mut Vec<IndexedCollection>) -> Vec<Uuid> {
        if field == 0 {
            return Vec::new();
        }
        let observation = IndexedCollection::observe(&mut self.graph, Address::of(box_uuid, vec![field]), EFFECT_INDEX_KEY);
        let sorted = observation.sorted();
        observation.take_dirty();
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
    fn build_cell(&mut self, track_sets: &SharedTrackSets, cell_uuid: Uuid, spec: &CompositeSpec)
        -> Option<(BuiltCluster, Vec<IndexedCollection>, Option<CompositeBinding>)> {
        let instrument_obs = IndexedCollection::observe(&mut self.graph, Address::of(cell_uuid, vec![spec.cell_instrument_field]), 0);
        instrument_obs.take_dirty();
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
        let midi = self.observe_child_chain(cell_uuid, spec.cell_midi_field, &mut chains);
        let audio = self.observe_child_chain(cell_uuid, spec.cell_audio_field, &mut chains);
        let cluster = self.build_cluster(PullLink::Source(sequencer), instrument_uuid, device, &midi, &audio);
        Some((cluster, chains, None))
    }
}
