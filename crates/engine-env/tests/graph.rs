//! TopologicalSort (ported from lib/dsp/src/graph.ts): a vertex is sorted only after its predecessors,
//! so sources come before consumers regardless of insertion order; diamonds keep the join last; and
//! feedback loops (cycles, self-loops) are detected without hanging.

use engine_env::graph::Graph;
use engine_env::topological_sort::TopologicalSort;

fn order(graph: &Graph<u32>) -> (Vec<u32>, bool) {
    let mut sort = TopologicalSort::new();
    sort.update(graph);
    (sort.sorted().to_vec(), sort.has_loops())
}

fn position(order: &[u32], vertex: u32) -> usize {
    order.iter().position(|entry| *entry == vertex).expect("vertex present")
}

#[test]
fn a_linear_chain_sorts_sources_first() {
    let mut graph = Graph::new();
    [1, 2, 3].iter().for_each(|&vertex| graph.add_vertex(vertex));
    graph.add_edge(1, 2); // 1 -> 2
    graph.add_edge(2, 3); // 2 -> 3
    let (sorted, has_loops) = order(&graph);
    assert_eq!(sorted, vec![1, 2, 3]);
    assert!(!has_loops);
}

#[test]
fn order_follows_dependencies_not_insertion() {
    // insert in reverse, wire 1 -> 2 -> 3; the order must still be 1, 2, 3.
    let mut graph = Graph::new();
    [3, 2, 1].iter().for_each(|&vertex| graph.add_vertex(vertex));
    graph.add_edge(1, 2);
    graph.add_edge(2, 3);
    let (sorted, _) = order(&graph);
    assert_eq!(sorted, vec![1, 2, 3]);
}

#[test]
fn a_diamond_keeps_the_join_last_and_the_root_first() {
    // 1 -> 2, 1 -> 3, 2 -> 4, 3 -> 4
    let mut graph = Graph::new();
    [1, 2, 3, 4].iter().for_each(|&vertex| graph.add_vertex(vertex));
    graph.add_edge(1, 2);
    graph.add_edge(1, 3);
    graph.add_edge(2, 4);
    graph.add_edge(3, 4);
    let (sorted, has_loops) = order(&graph);
    assert!(!has_loops);
    assert_eq!(sorted.len(), 4);
    assert_eq!(sorted[0], 1, "the root renders first");
    assert_eq!(sorted[3], 4, "the join renders last");
    assert!(position(&sorted, 2) < position(&sorted, 4) && position(&sorted, 3) < position(&sorted, 4));
}

#[test]
fn a_two_node_cycle_is_flagged() {
    let mut graph = Graph::new();
    [1, 2].iter().for_each(|&vertex| graph.add_vertex(vertex));
    graph.add_edge(1, 2);
    graph.add_edge(2, 1);
    let (_, has_loops) = order(&graph);
    assert!(has_loops, "a 1<->2 cycle is detected");
}

#[test]
fn a_self_loop_is_flagged() {
    let mut graph = Graph::new();
    graph.add_vertex(1);
    graph.add_edge(1, 1);
    let (_, has_loops) = order(&graph);
    assert!(has_loops);
}

#[test]
fn removing_an_edge_breaks_a_cycle() {
    let mut graph = Graph::new();
    [1, 2].iter().for_each(|&vertex| graph.add_vertex(vertex));
    graph.add_edge(1, 2);
    graph.add_edge(2, 1);
    assert!(order(&graph).1, "cyclic before removal");
    graph.remove_edge(2, 1);
    let (sorted, has_loops) = order(&graph);
    assert!(!has_loops, "acyclic after removal");
    assert_eq!(sorted, vec![1, 2]);
}

#[test]
fn an_empty_graph_sorts_to_nothing() {
    let graph: Graph<u32> = Graph::new();
    assert!(graph.is_empty());
    let (sorted, has_loops) = order(&graph);
    assert!(sorted.is_empty());
    assert!(!has_loops);
}

#[test]
fn disconnected_vertices_all_appear() {
    let mut graph = Graph::new();
    [1, 2, 3].iter().for_each(|&vertex| graph.add_vertex(vertex));
    let (mut sorted, has_loops) = order(&graph);
    sorted.sort_unstable();
    assert_eq!(sorted, vec![1, 2, 3]);
    assert!(!has_loops);
}
