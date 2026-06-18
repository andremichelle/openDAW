//! Topological sort over a `Graph`, ported from `lib/dsp/src/graph.ts`. Visits a vertex's predecessors
//! first (so sources come before consumers) and flags feedback loops via a transitive-successor set.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;
use crate::graph::Graph;

pub struct TopologicalSort<V: Ord + Copy> {
    sorted: Vec<V>,
    visited: BTreeSet<V>,
    with_loops: BTreeSet<V>,
    successors: BTreeMap<V, BTreeSet<V>>
}

impl<V: Ord + Copy> TopologicalSort<V> {
    pub fn new() -> Self {
        Self {sorted: Vec::new(), visited: BTreeSet::new(), with_loops: BTreeSet::new(), successors: BTreeMap::new()}
    }

    /// Recompute the order for `graph`. Must run again after any vertex/edge change.
    pub fn update(&mut self, graph: &Graph<V>) {
        self.prepare(graph);
        for &vertex in graph.vertices() {
            self.visit(graph, vertex);
        }
    }

    /// The vertices in dependency order (sources before consumers), valid after `update`.
    pub fn sorted(&self) -> &[V] {
        &self.sorted
    }

    pub fn has_loops(&self) -> bool {
        !self.with_loops.is_empty()
    }

    // Build the transitive successor set for every vertex (used to detect feedback loops in `visit`).
    fn prepare(&mut self, graph: &Graph<V>) {
        self.clear();
        let mut add_to: BTreeMap<V, BTreeSet<V>> = BTreeMap::new();
        for &vertex in graph.vertices() {
            self.successors.insert(vertex, BTreeSet::new());
            add_to.insert(vertex, BTreeSet::new());
        }
        for &target in graph.vertices() {
            for &source in graph.get_predecessors(target) {
                self.successors.get_mut(&source).expect("successor").insert(target);
            }
        }
        loop {
            let mut change = false;
            for &vertex in graph.vertices() {
                add_to.get_mut(&vertex).expect("add_to").clear();
                let direct: Vec<V> = self.successors.get(&vertex).expect("successors").iter().copied().collect();
                for successor in direct {
                    let transitive: Vec<V> = self.successors.get(&successor)
                        .map_or_else(Vec::new, |set| set.iter().copied().collect());
                    for reached in transitive {
                        if !self.successors.get(&vertex).expect("successors").contains(&reached) {
                            change = true;
                            add_to.get_mut(&vertex).expect("add_to").insert(reached);
                        }
                    }
                }
            }
            for &vertex in graph.vertices() {
                let pending: Vec<V> = add_to.get(&vertex).expect("add_to").iter().copied().collect();
                let successors = self.successors.get_mut(&vertex).expect("successors");
                for reached in pending {
                    successors.insert(reached);
                }
            }
            if !change {
                break;
            }
        }
    }

    fn visit(&mut self, graph: &Graph<V>, vertex: V) {
        if self.visited.contains(&vertex) {
            return;
        }
        self.visited.insert(vertex);
        for &predecessor in graph.get_predecessors(vertex) {
            if self.successors.get(&vertex).is_some_and(|set| set.contains(&predecessor)) {
                self.with_loops.insert(vertex);
                self.with_loops.insert(predecessor);
                continue;
            }
            self.visit(graph, predecessor);
        }
        self.sorted.push(vertex);
    }

    fn clear(&mut self) {
        self.sorted.clear();
        self.visited.clear();
        self.with_loops.clear();
        self.successors.clear();
    }
}

impl<V: Ord + Copy> Default for TopologicalSort<V> {
    fn default() -> Self {
        Self::new()
    }
}
