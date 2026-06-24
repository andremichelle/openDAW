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
use crate::{CompositeSpec, Engine, PullLink};

/// A composite's reactive cascade, owned by the unit whose instrument is the composite: the child-collection
/// observation plus the bindings of any nested composites. `take_dirty` returns whether the child set (at any
/// depth) changed since the last reconcile; `terminate` unsubscribes the whole tree on rewire / teardown.
pub(crate) struct CompositeBinding {
    children: IndexedCollection,
    nested: Vec<CompositeBinding>
}

impl CompositeBinding {
    /// Whether a child was added / removed / reordered at this level OR in any nested composite. Consumes the
    /// flag at every level (no short-circuit), so one dirty does not mask another.
    pub(crate) fn take_dirty(&self) -> bool {
        let mut dirty = self.children.take_dirty();
        for child in &self.nested {
            dirty |= child.take_dirty();
        }
        dirty
    }

    /// Unsubscribe the child collection and every nested composite (rewire / teardown).
    pub(crate) fn terminate(self, graph: &mut BoxGraph) {
        self.children.terminate(graph);
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
        let mut nested = Vec::new();
        // Read each child's routing note (`index_key`) and choke-group flag (`exclude_key`) from the box once.
        // The choke group is every exclude child's note, so an exclude child receives a CHOKE when any OTHER
        // exclude child fires. A child with no index gets the whole stream (a full instrument).
        let infos: Vec<(Uuid, Option<i32>, bool)> = child_uuids.iter().map(|&uuid| {
            let index = self.graph.field_value(&Address::of(uuid, vec![spec.index_key])).and_then(|value| value.as_int32());
            let exclude = spec.exclude_key != 0
                && self.graph.field_value(&Address::of(uuid, vec![spec.exclude_key])).and_then(|value| value.as_bool()).unwrap_or(false);
            (uuid, index, exclude)
        }).collect();
        let exclude_notes: Vec<i32> = infos.iter().filter(|(_, _, exclude)| *exclude).filter_map(|(_, index, _)| *index).collect();
        for (child_uuid, index, exclude) in infos {
            // The child's choke group is every OTHER exclude child's note (it filters its own note itself).
            let choke: Rc<[i32]> = if exclude {
                Rc::from(exclude_notes.iter().copied().filter(|note| Some(*note) != index).collect::<Vec<i32>>())
            } else {
                Rc::from(Vec::new())
            };
            if let Some((child, child_binding)) = self.build_instrument(track_sets, child_uuid, choke) {
                sum.borrow_mut().add_audio_source(child.output);
                self.context.register_edge(child.output_node, sum_id);
                edges.push((child.output_node, sum_id));
                nodes.extend(child.nodes);
                edges.extend(child.edges);
                device_params.extend(child.device_params);
                device_uuids.extend(child.device_uuids);
                if let Some(binding) = child_binding {
                    nested.push(binding);
                }
            }
        }
        (BuiltCluster {output: sum_buffer, output_node: sum_id, nodes, edges, device_params, device_uuids},
         CompositeBinding {children, nested})
    }

    /// Build one child instrument node for `box_uuid`, dispatching on its OWN box type: a nested composite
    /// (recurse) or a leaf voice device. A leaf reads the unit's regions through its own sequencer, filtered to
    /// its routing note (`filter_index`) when the composite assigns one. Returns the cluster plus an optional
    /// nested cascade, or `None` if the box has no plugin / composite spec (the child is silently skipped).
    fn build_instrument(&mut self, track_sets: &SharedTrackSets, box_uuid: Uuid, choke: Rc<[i32]>)
        -> Option<(BuiltCluster, Option<CompositeBinding>)> {
        let name = self.graph.find_box(&box_uuid)?.name.clone();
        if let Some(spec) = self.composite_for_type(&name) {
            // A nested composite routes its own children internally, so it takes the full stream here.
            let (cluster, binding) = self.build_composite(track_sets, box_uuid, &spec);
            return Some((cluster, Some(binding)));
        }
        let device = self.device_for_type(&name).filter(|device| device.kind == DEVICE_KIND_INSTRUMENT)?;
        let sequencer: SharedNoteEventSource =
            Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: track_sets.clone()}))));
        // EVERY child gets the full broadcast stream and filters its own note itself (a Playfield slot by its
        // observed `index`; a full instrument filters nothing and plays all). A child in a choke group also gets
        // its sibling chokes injected. Per-child fx chains come later (step 5).
        let source = if choke.is_empty() {
            PullLink::Source(sequencer)
        } else {
            PullLink::SlotRoute {upstream: sequencer, choke}
        };
        Some((self.build_cluster(source, box_uuid, device, &[], &[]), None))
    }
}
