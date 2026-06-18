//! Ordering-only processor graph, ported from `lib/dsp/src/graph.ts`. The graph records vertices and,
//! per vertex, its predecessors (incoming edges). It carries dependency order only and never routes
//! audio: a registered edge means "source runs before target". `TopologicalSort` (its own module)
//! turns this into an order.
//!
//! The TS version keys its `Map` by object identity; here a vertex is a key type (`V: Ord + Copy`, a
//! node id in practice), so the map is a `BTreeMap`.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

pub struct Graph<V: Ord + Copy> {
    vertices: Vec<V>,
    predecessors: BTreeMap<V, Vec<V>>
}

impl<V: Ord + Copy> Graph<V> {
    pub fn new() -> Self {
        Self {vertices: Vec::new(), predecessors: BTreeMap::new()}
    }

    pub fn add_vertex(&mut self, vertex: V) {
        debug_assert!(!self.vertices.contains(&vertex), "Vertex already exists");
        self.vertices.push(vertex);
        let previous = self.predecessors.insert(vertex, Vec::new());
        debug_assert!(previous.is_none(), "Predecessor already exists");
    }

    pub fn remove_vertex(&mut self, vertex: V) {
        if let Some(index) = self.vertices.iter().position(|entry| *entry == vertex) {
            self.vertices.remove(index);
        }
        let removed = self.predecessors.remove(&vertex);
        debug_assert!(removed.is_some(), "Predecessor does not exist");
    }

    pub fn get_predecessors(&self, vertex: V) -> &[V] {
        self.predecessors.get(&vertex).map_or(&[], |list| list.as_slice())
    }

    pub fn vertices(&self) -> &[V] {
        &self.vertices
    }

    pub fn add_edge(&mut self, source: V, target: V) {
        let predecessors = self.predecessors.get_mut(&target).expect("[add] Edge has unannounced vertex");
        predecessors.push(source);
    }

    pub fn remove_edge(&mut self, source: V, target: V) {
        let predecessors = self.predecessors.get_mut(&target).expect("[remove] Edge has unannounced vertex");
        if let Some(index) = predecessors.iter().position(|entry| *entry == source) {
            predecessors.remove(index);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.vertices.is_empty()
    }
}

impl<V: Ord + Copy> Default for Graph<V> {
    fn default() -> Self {
        Self::new()
    }
}
