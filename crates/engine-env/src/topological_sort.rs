//! Topological sort over a `Graph` (contract from `lib/dsp/src/graph.ts`: sources before consumers,
//! feedback loops flagged). ALLOCATION-FREE in `update`: an iterative tri-color depth-first search over
//! retained buffers, pre-sized via `reserve` at processor-registration time (reconcile), because `update`
//! runs lazily inside the render callback where the engine must never allocate. Deviation from the TS
//! transitive-successor algorithm (deliberate): a cycle is detected as a back-edge to a GRAY vertex, so
//! WHICH vertices get flagged in an already-cyclic graph can differ, but the sorted order for acyclic
//! graphs (the only shape production allows, `would_cycle` rejects loops up front) is identical, and
//! `has_loops` agrees. O(V + E) instead of O(V^3).

use alloc::vec::Vec;
use crate::graph::Graph;

const WHITE: u8 = 0; // unvisited
const GRAY: u8 = 1; // on the current DFS path
const BLACK: u8 = 2; // sorted

pub struct TopologicalSort<V: Ord + Copy> {
    sorted: Vec<V>,
    with_loops: Vec<V>,
    states: Vec<(V, u8)>, // sorted by vertex for binary search
    stack: Vec<(V, usize)> // DFS frames: (vertex, next predecessor index)
}

impl<V: Ord + Copy> TopologicalSort<V> {
    pub fn new() -> Self {
        Self {sorted: Vec::new(), with_loops: Vec::new(), states: Vec::new(), stack: Vec::new()}
    }

    /// Pre-size the retained buffers for `vertices` nodes. Called where allocation is allowed (processor
    /// registration during reconcile), so a later `update` inside render never grows them.
    pub fn reserve(&mut self, vertices: usize) {
        self.sorted.reserve(vertices.saturating_sub(self.sorted.len()));
        self.states.reserve(vertices.saturating_sub(self.states.len()));
        self.stack.reserve(vertices.saturating_sub(self.stack.len()));
    }

    /// Recompute the order for `graph`. Must run again after any vertex/edge change. Allocation-free
    /// once `reserve` covered the vertex count (each vertex enters `stack`/`sorted` exactly once).
    pub fn update(&mut self, graph: &Graph<V>) {
        self.sorted.clear();
        self.with_loops.clear();
        self.states.clear();
        self.stack.clear();
        for &vertex in graph.vertices() {
            self.states.push((vertex, WHITE));
        }
        self.states.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        for &vertex in graph.vertices() {
            if self.state(vertex) == WHITE {
                self.dfs(graph, vertex);
            }
        }
    }

    /// The vertices in dependency order (sources before consumers), valid after `update`.
    pub fn sorted(&self) -> &[V] {
        &self.sorted
    }

    pub fn has_loops(&self) -> bool {
        !self.with_loops.is_empty()
    }

    // Iterative depth-first search, predecessors first: a WHITE predecessor is descended into, a GRAY one
    // is a back-edge (feedback loop, flagged and skipped), a BLACK one is already sorted. A vertex is
    // pushed to `sorted` when all its predecessors are done (post-order), matching the recursive TS visit.
    fn dfs(&mut self, graph: &Graph<V>, root: V) {
        self.set_state(root, GRAY);
        self.stack.push((root, 0));
        while let Some(&(vertex, index)) = self.stack.last() {
            let predecessors = graph.get_predecessors(vertex);
            if index < predecessors.len() {
                self.stack.last_mut().expect("frame").1 += 1;
                let predecessor = predecessors[index];
                match self.state(predecessor) {
                    WHITE => {
                        self.set_state(predecessor, GRAY);
                        self.stack.push((predecessor, 0));
                    }
                    GRAY => {
                        self.flag_loop(vertex);
                        self.flag_loop(predecessor);
                    }
                    _ => {}
                }
            } else {
                self.stack.pop();
                self.set_state(vertex, BLACK);
                self.sorted.push(vertex);
            }
        }
    }

    fn state(&self, vertex: V) -> u8 {
        self.states.binary_search_by(|entry| entry.0.cmp(&vertex)).map_or(WHITE, |index| self.states[index].1)
    }

    fn set_state(&mut self, vertex: V, state: u8) {
        if let Ok(index) = self.states.binary_search_by(|entry| entry.0.cmp(&vertex)) {
            self.states[index].1 = state;
        }
    }

    // Loops are exceptional (production rejects them via `would_cycle`), so this rare push growing the
    // retained buffer is acceptable.
    fn flag_loop(&mut self, vertex: V) {
        if !self.with_loops.contains(&vertex) {
            self.with_loops.push(vertex);
        }
    }
}

impl<V: Ord + Copy> Default for TopologicalSort<V> {
    fn default() -> Self {
        Self::new()
    }
}
