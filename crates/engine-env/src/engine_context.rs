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
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::rc::Rc;
use alloc::string::String;
use alloc::vec::Vec;
use core::cell::RefCell;
use crate::audio_output_buffer_registry::AudioOutputBufferRegistry;
use crate::compensation::{CompensationLimits, SignalEdge, SignalGraph, SignalNode};
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
    owners: BTreeMap<NodeId, [u8; 16]>,
    order_edges: BTreeSet<(NodeId, NodeId)>,
    edge_delays: BTreeMap<(NodeId, NodeId), u32>,
    compensation_dirty: bool,
    profiler: Option<Profiler>,
    // The topsorted processors CACHED as handles (rebuilt with the sort), so the steady-state render loop is
    // a linear walk with zero per-node BTreeMap lookups. Rc clones only; capacity reserved at registration.
    queue: Vec<(NodeId, SharedProcessor)>,
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
            owners: BTreeMap::new(),
            order_edges: BTreeSet::new(),
            edge_delays: BTreeMap::new(),
            compensation_dirty: false,
            profiler: None,
            queue: Vec::new(),
            needs_sort: false
        }
    }

    /// Attach a human-readable label to a node (its box type / role), for the profiler report. Reconcile-time.
    pub fn set_label(&mut self, id: NodeId, label: String) {
        self.labels.insert(id, label);
    }

    /// The box (unit, bus, device, send) a node renders for, so the signal graph page can name it.
    pub fn set_owner(&mut self, id: NodeId, owner: [u8; 16]) {
        self.owners.insert(id, owner);
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
        self.queue.reserve(self.graph.vertices().len().saturating_sub(self.queue.len()));
        if let Some(profiler) = &mut self.profiler {
            profiler.accum.resize(self.next_id as usize, 0.0); // grow at reconcile, never during render
        }
        self.needs_sort = true;
        self.compensation_dirty = true;
        id
    }

    /// Order `source` before `target` in the render (TS `registerEdge`).
    pub fn register_edge(&mut self, source: NodeId, target: NodeId) {
        self.graph.add_edge(source, target);
        self.needs_sort = true;
        self.compensation_dirty = true;
    }

    /// Order `source` before `target` without carrying audio into `target` (a sidechain tap).
    pub fn register_order_edge(&mut self, source: NodeId, target: NodeId) {
        self.register_edge(source, target);
        self.order_edges.insert((source, target));
    }

    /// Remove a node and its processor (the explicit engine-side re-wire step the module doc notes). The
    /// caller removes any edges INTO other nodes (e.g. into a bus) via `remove_edge` first; this drops the
    /// node's own vertex and predecessor list.
    pub fn remove_processor(&mut self, id: NodeId) {
        self.graph.remove_vertex(id);
        self.processors.remove(&id);
        self.owners.remove(&id);
        self.order_edges.retain(|(source, target)| *source != id && *target != id);
        self.labels.remove(&id); // ids are never reused; keeping dead labels would grow forever
        // Drop the cached render queue NOW (it rebuilds on the next `process` anyway): its Rc clones would
        // keep the removed processor alive past this reconcile — its telemetry slots then read as ALIVE,
        // blocking a same-address re-registration and surviving the sweep, only to die mid-render and leave
        // the broadcast table serving a freed pointer (the PeakMeter NaN). TS drops a removed processor
        // synchronously; mirror that. `clear` keeps the capacity, so the in-render rebuild never allocates.
        self.queue.clear();
        self.needs_sort = true;
        self.compensation_dirty = true;
    }

    /// Remove an ordering edge (the inverse of `register_edge`).
    pub fn remove_edge(&mut self, source: NodeId, target: NodeId) {
        self.graph.remove_edge(source, target);
        self.order_edges.remove(&(source, target));
        self.needs_sort = true;
        self.compensation_dirty = true;
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

    /// Snapshot of every node and edge with reported latencies and arrivals. Diagnostic, allocates.
    pub fn signal_graph(&self) -> SignalGraph {
        let mut arrivals: BTreeMap<NodeId, u32> = BTreeMap::new();
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for &id in self.graph.vertices() {
            let latency = self.processors.get(&id).map_or(0, |processor| processor.borrow().latency());
            nodes.push(SignalNode {
                id,
                label: self.labels.get(&id).cloned().unwrap_or_else(|| String::from("<unlabeled>")),
                owner: self.owners.get(&id).copied(),
                latency,
                arrival: self.arrival(id, &mut arrivals)
            });
            for &source in self.graph.get_predecessors(id) {
                let delay = self.edge_delays.get(&(source, id)).copied().unwrap_or(0);
                edges.push(SignalEdge {source, target: id, data: !self.order_edges.contains(&(source, id)), delay});
            }
        }
        SignalGraph {nodes, edges}
    }

    fn arrival(&self, id: NodeId, memo: &mut BTreeMap<NodeId, u32>) -> u32 {
        if let Some(&arrival) = memo.get(&id) {
            return arrival;
        }
        memo.insert(id, 0); // a feedback route (a sidechain from downstream) reads 0 instead of recursing forever
        let (own, junction, aligns) = self.processors.get(&id).map_or((0, None, false), |processor| {
            let processor = processor.borrow();
            (processor.latency(), processor.junction_sources(), processor.aligns_inputs())
        });
        let upstream = match junction {
            Some(sources) => sources.iter().map(|&source| self.arrival(source, memo)).max().unwrap_or(0),
            None => self.graph.get_predecessors(id).iter()
                .filter(|&&source| !self.order_edges.contains(&(source, id)) || (aligns && !self.would_cycle(source, id)))
                .map(|&source| self.arrival(source, memo)).max().unwrap_or(0)
        };
        memo.insert(id, own + upstream);
        own + upstream
    }

    /// The latency at which `id`'s output arrives, relative to the timeline. Outside render.
    pub fn arrival_of(&self, id: NodeId) -> u32 {
        self.arrival(id, &mut BTreeMap::new())
    }

    pub fn compensation_dirty(&self) -> bool {
        self.compensation_dirty
    }

    pub fn mark_compensation_dirty(&mut self) {
        self.compensation_dirty = true;
    }

    /// Align every junction: each input is delayed to the latest one, within `limits`. Outside render.
    pub fn compensate(&mut self, limits: CompensationLimits) {
        self.compensation_dirty = false;
        self.edge_delays.clear();
        let mut memo: BTreeMap<NodeId, u32> = BTreeMap::new();
        for (&id, processor) in &self.processors {
            let Some(sources) = processor.borrow().junction_sources() else { continue };
            let arrivals: Vec<u32> = sources.iter().map(|&source| self.arrival(source, &mut memo)).collect();
            let latest = arrivals.iter().copied().max().unwrap_or(0);
            let delays: Vec<u32> = arrivals.iter().map(|arrival| latest - arrival).collect();
            for (&source, arrival) in sources.iter().zip(&arrivals) {
                if latest > *arrival {
                    self.edge_delays.insert((source, id), latest - arrival);
                }
            }
            processor.borrow_mut().set_junction_delays(&delays, limits);
        }
        for (&id, processor) in &self.processors {
            if !processor.borrow().aligns_inputs() {
                continue;
            }
            let (sidechains, mains): (Vec<NodeId>, Vec<NodeId>) = self.graph.get_predecessors(id).iter()
                .filter(|&&source| !self.order_edges.contains(&(source, id)) || !self.would_cycle(source, id))
                .partition(|&&source| self.order_edges.contains(&(source, id)));
            if sidechains.is_empty() {
                processor.borrow_mut().set_input_delays(0, &[], limits);
                continue;
            }
            let main = mains.iter().map(|&source| self.arrival(source, &mut memo)).max().unwrap_or(0);
            let arrivals: Vec<(NodeId, u32)> = sidechains.iter().map(|&source| (source, self.arrival(source, &mut memo))).collect();
            let latest = arrivals.iter().map(|(_, arrival)| *arrival).max().unwrap_or(0).max(main);
            for &source in &mains {
                if latest > main {
                    self.edge_delays.insert((source, id), latest - main);
                }
            }
            let delays: Vec<(NodeId, u32)> = arrivals.iter().map(|&(source, arrival)| {
                if latest > arrival {
                    self.edge_delays.insert((source, id), latest - arrival);
                }
                (source, latest - arrival)
            }).collect();
            processor.borrow_mut().set_input_delays(latest - main, &delays, limits);
        }
    }

    /// Run an observer in each `ProcessPhase` (TS `subscribeProcessPhase`). Unsubscription is deferred.
    pub fn subscribe_process_phase(&mut self, observer: Box<dyn FnMut(ProcessPhase)>) {
        self.phase_observers.push(observer);
    }

    /// Diagnostic container sizes for leak probes: processors, labels, queue len/capacity, next node id,
    /// registry entries, live graph vertices. Reconcile-time only.
    pub fn debug_counts(&self) -> [u32; 7] {
        [self.processors.len() as u32, self.labels.len() as u32, self.queue.len() as u32,
            self.queue.capacity() as u32, self.next_id as u32, self.registry.len() as u32,
            self.graph.vertices().len() as u32]
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
            self.queue.clear();
            for &id in self.sort.sorted() {
                if let Some(processor) = self.processors.get(&id) {
                    self.queue.push((id, processor.clone()));
                }
            }
            self.needs_sort = false;
        }
        match &mut self.profiler {
            Some(profiler) => {
                for (id, processor) in &self.queue {
                    let begin = (profiler.now)();
                    processor.borrow_mut().process(info);
                    profiler.accum[*id as usize] += (profiler.now)() - begin;
                }
                profiler.quanta += 1;
            }
            None => {
                for (_, processor) in &self.queue {
                    processor.borrow_mut().process(info);
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
