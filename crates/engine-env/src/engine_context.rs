//! EngineContext: the handle every processor/device gets to register itself into the one processor
//! graph, plus the topsorted render loop over that graph. Ported from core-processors `EngineContext`
//! (the registration surface) folded with the part of `EngineProcessor` that owns the graph + runs the
//! render loop, because Rust ownership wants the graph + processors in one place.
//!
//! Processors are shared single-threaded objects (`Rc<RefCell<dyn Processor>>`), consistent with
//! `SharedAudioBuffer`: a parent (a unit / chain) keeps a typed handle to call wiring methods and
//! registers a clone here so the loop can drive it. Routing edges are by `NodeId` (TS passes the
//! `Processor` object; our graph keys on an id).
//!
//! Deferred (need subsystems not yet ported): `getAudioUnit`, `broadcaster`, `updateClock`, `timeInfo`,
//! `mixer`, `preferences`, `baseFrequency`, MIDI / monitoring, and `Terminable`-based unregistration.
//! Also: TS re-wires inside a `Before` observer that calls `register_edge`; a Rust closure cannot hold
//! `&mut` the context it lives in, so phase observers here are self-contained hooks (capturing their own
//! `Rc<RefCell>` state) and context-mutating re-wiring will be an explicit engine step.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::RefCell;
use crate::audio_output_buffer_registry::AudioOutputBufferRegistry;
use crate::graph::Graph;
use crate::process_info::ProcessInfo;
use crate::process_phase::ProcessPhase;
use crate::processor::Processor;
use crate::topological_sort::TopologicalSort;

/// Identifies a processor node in the graph (TS keys on the `Processor` object; we assign an id).
pub type NodeId = u64;

/// A shared, single-threaded processor handle (mirrors `SharedAudioBuffer`).
pub type SharedProcessor = Rc<RefCell<dyn Processor>>;

pub struct EngineContext {
    next_id: NodeId,
    graph: Graph<NodeId>,
    sort: TopologicalSort<NodeId>,
    processors: BTreeMap<NodeId, SharedProcessor>,
    registry: AudioOutputBufferRegistry<NodeId>,
    phase_observers: Vec<Box<dyn FnMut(ProcessPhase)>>,
    needs_sort: bool
}

impl EngineContext {
    pub fn new() -> Self {
        Self {
            next_id: 0,
            graph: Graph::new(),
            sort: TopologicalSort::new(),
            processors: BTreeMap::new(),
            registry: AudioOutputBufferRegistry::new(),
            phase_observers: Vec::new(),
            needs_sort: false
        }
    }

    /// Add a processor node, returning its id (TS `registerProcessor`). The caller keeps its own typed
    /// handle for wiring; the context keeps a clone to drive it in the render loop.
    pub fn register_processor(&mut self, processor: SharedProcessor) -> NodeId {
        let id = self.next_id;
        self.next_id += 1;
        self.graph.add_vertex(id);
        self.processors.insert(id, processor);
        self.needs_sort = true;
        id
    }

    /// Order `source` before `target` in the render (TS `registerEdge`).
    pub fn register_edge(&mut self, source: NodeId, target: NodeId) {
        self.graph.add_edge(source, target);
        self.needs_sort = true;
    }

    /// Remove a node and its processor (the explicit engine-side re-wire step the module doc notes). The
    /// caller removes any edges INTO other nodes (e.g. into a bus) via `remove_edge` first; this drops the
    /// node's own vertex and predecessor list.
    pub fn remove_processor(&mut self, id: NodeId) {
        self.graph.remove_vertex(id);
        self.processors.remove(&id);
        self.needs_sort = true;
    }

    /// Remove an ordering edge (the inverse of `register_edge`).
    pub fn remove_edge(&mut self, source: NodeId, target: NodeId) {
        self.graph.remove_edge(source, target);
        self.needs_sort = true;
    }

    /// Run an observer in each `ProcessPhase` (TS `subscribeProcessPhase`). Unsubscription is deferred.
    pub fn subscribe_process_phase(&mut self, observer: Box<dyn FnMut(ProcessPhase)>) {
        self.phase_observers.push(observer);
    }

    pub fn registry(&self) -> &AudioOutputBufferRegistry<NodeId> {
        &self.registry
    }

    pub fn registry_mut(&mut self) -> &mut AudioOutputBufferRegistry<NodeId> {
        &mut self.registry
    }

    /// Render one quantum: emit `Before`, re-sort if the graph changed, process every node in
    /// dependency order, then emit `After` (TS `EngineProcessor.process` over the sorted queue).
    pub fn process(&mut self, info: &ProcessInfo) {
        self.emit(ProcessPhase::Before);
        if self.needs_sort {
            self.sort.update(&self.graph);
            self.needs_sort = false;
        }
        let count = self.sort.sorted().len();
        for index in 0..count {
            let id = self.sort.sorted()[index];
            if let Some(processor) = self.processors.get(&id) {
                processor.borrow_mut().process(info);
            }
        }
        self.emit(ProcessPhase::After);
    }

    fn emit(&mut self, phase: ProcessPhase) {
        for observer in &mut self.phase_observers {
            observer(phase);
        }
    }
}

impl Default for EngineContext {
    fn default() -> Self {
        Self::new()
    }
}
