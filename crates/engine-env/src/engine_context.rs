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
use alloc::string::String;
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

// The render-loop PROFILER (diagnostic, off by default): per-node accumulated wall time via a host-provided
// clock. `accum` is indexed by NodeId and pre-grown at registration (reconcile), so the per-render timing
// adds two clock calls per node and NO allocation. Labels are recorded at registration regardless (cheap,
// reconcile-time), so enabling the profiler later still reports meaningful names.
struct Profiler {
    now: fn() -> f64, // micros (host `performance.now() * 1000`)
    accum: Vec<f64>,
    quanta: u64
}

pub struct EngineContext {
    next_id: NodeId,
    graph: Graph<NodeId>,
    sort: TopologicalSort<NodeId>,
    processors: BTreeMap<NodeId, SharedProcessor>,
    registry: AudioOutputBufferRegistry<NodeId>,
    phase_observers: Vec<Box<dyn FnMut(ProcessPhase)>>,
    labels: BTreeMap<NodeId, String>,
    profiler: Option<Profiler>,
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
            labels: BTreeMap::new(),
            profiler: None,
            needs_sort: false
        }
    }

    /// Attach a human-readable label to a node (its box type / role), for the profiler report. Reconcile-time.
    pub fn set_label(&mut self, id: NodeId, label: String) {
        self.labels.insert(id, label);
    }

    /// Enable per-node render profiling with the given micros clock, (re)zeroing the accumulators.
    pub fn profile_enable(&mut self, now: fn() -> f64) {
        let mut accum = Vec::new();
        accum.resize(self.next_id as usize, 0.0);
        self.profiler = Some(Profiler {now, accum, quanta: 0});
    }

    /// The profile so far: (label, total micros) per node, unsorted, plus the profiled quantum count.
    pub fn profile_report(&self) -> (Vec<(String, f64)>, u64) {
        match &self.profiler {
            Some(profiler) => {
                let entries = profiler.accum.iter().enumerate()
                    .filter(|(_, micros)| **micros > 0.0)
                    .map(|(id, micros)| {
                        let label = self.labels.get(&(id as NodeId)).cloned()
                            .unwrap_or_else(|| String::from("<unlabeled>"));
                        (label, *micros)
                    })
                    .collect();
                (entries, profiler.quanta)
            }
            None => (Vec::new(), 0)
        }
    }

    /// Add a processor node, returning its id (TS `registerProcessor`). The caller keeps its own typed
    /// handle for wiring; the context keeps a clone to drive it in the render loop.
    pub fn register_processor(&mut self, processor: SharedProcessor) -> NodeId {
        let id = self.next_id;
        self.next_id += 1;
        self.graph.add_vertex(id);
        self.processors.insert(id, processor);
        self.sort.reserve(self.graph.vertices().len()); // pre-size here (reconcile) so the lazy in-render sort never allocates
        if let Some(profiler) = &mut self.profiler {
            profiler.accum.resize(self.next_id as usize, 0.0); // grow at reconcile, never during render
        }
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

    /// Whether a node is still a registered vertex — checked before `remove_edge`, which panics on a missing
    /// TARGET vertex (a torn-down bus's sum node whose incoming edges vanished with it).
    pub fn has_node(&self, id: NodeId) -> bool {
        self.graph.vertices().contains(&id)
    }

    /// Whether adding the edge `source -> target` would close a cycle: true iff `target` is already a
    /// (transitive) predecessor of `source` (so `source` already depends on `target`, and the new edge would
    /// make `target` depend on `source`). Used to reject a feedback loop in output / send bus routing up front
    /// (the topological sort silently drops a back-edge; rejecting here is clearer and keeps the graph acyclic).
    pub fn would_cycle(&self, source: NodeId, target: NodeId) -> bool {
        let mut stack = alloc::vec![source];
        let mut seen = alloc::collections::BTreeSet::new();
        while let Some(node) = stack.pop() {
            for &predecessor in self.graph.get_predecessors(node) {
                if predecessor == target {
                    return true;
                }
                if seen.insert(predecessor) {
                    stack.push(predecessor);
                }
            }
        }
        false
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
        match &mut self.profiler {
            Some(profiler) => {
                for index in 0..count {
                    let id = self.sort.sorted()[index];
                    if let Some(processor) = self.processors.get(&id) {
                        let begin = (profiler.now)();
                        processor.borrow_mut().process(info);
                        profiler.accum[id as usize] += (profiler.now)() - begin;
                    }
                }
                profiler.quanta += 1;
            }
            None => {
                for index in 0..count {
                    let id = self.sort.sorted()[index];
                    if let Some(processor) = self.processors.get(&id) {
                        processor.borrow_mut().process(info);
                    }
                }
            }
        }
        self.emit(ProcessPhase::After);
    }

    /// Reset every processor (a transport STOP): each device clears its runtime state, and the buses / channel
    /// strips clear their buffers, so the next playback starts silent. Outside render.
    pub fn reset_all(&mut self) {
        for processor in self.processors.values() {
            processor.borrow_mut().reset();
        }
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
