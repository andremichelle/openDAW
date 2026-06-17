use std::collections::BTreeMap;
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::field::{FieldType, FieldValue, Schema};
use boxgraph::graph::BoxGraph;

const A: Uuid = [0xA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const B: Uuid = [0xB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MISSING: Uuid = [0xC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

fn registry() -> Registry {
    Registry::from([
        ("Node".to_string(), Schema::from([(0, FieldType::Int32), (1, FieldType::Pointer)]))
    ])
}

fn node(creation_index: i32, uuid: Uuid, value: i32, pointer: Option<Address>) -> GraphBox {
    GraphBox {
        creation_index,
        name: "Node".to_string(),
        uuid,
        fields: BTreeMap::from([(0, FieldValue::Int32(value)), (1, FieldValue::Pointer(pointer))])
    }
}

#[test]
fn graph_bytes_round_trip_preserves_boxes() {
    let graph = BoxGraph::from_boxes(vec![
        node(0, A, 1, Some(Address::box_of(B))),
        node(1, B, 2, None)
    ]);
    let bytes = graph.to_bytes();
    let reloaded = BoxGraph::from_bytes(&bytes, &registry()).unwrap();
    assert_eq!(reloaded.box_count(), 2);
    assert_eq!(reloaded.find_box(&A), graph.find_box(&A));
    assert_eq!(reloaded.find_box(&B), graph.find_box(&B));
    assert_eq!(reloaded.to_bytes(), bytes);
}

#[test]
fn box_to_box_edge_resolves_both_directions() {
    let graph = BoxGraph::from_boxes(vec![
        node(0, A, 1, Some(Address::box_of(B))),
        node(1, B, 2, None)
    ]);
    let source = Address::of(A, vec![1]);
    assert_eq!(graph.target_of(&source), Some(&Address::box_of(B)));
    assert_eq!(graph.incoming(&Address::box_of(B)), vec![&source]);
    assert!(graph.dangling().is_empty());
}

#[test]
fn pointer_to_a_field_resolves() {
    let target = Address::of(B, vec![0]);
    let graph = BoxGraph::from_boxes(vec![
        node(0, A, 1, Some(target.clone())),
        node(1, B, 2, None)
    ]);
    assert!(graph.vertex_exists(&target));
    assert_eq!(graph.incoming(&target), vec![&Address::of(A, vec![1])]);
    assert!(graph.dangling().is_empty());
}

#[test]
fn dangling_pointer_to_missing_box() {
    let graph = BoxGraph::from_boxes(vec![node(0, A, 1, Some(Address::box_of(MISSING)))]);
    assert_eq!(graph.dangling().len(), 1);
    assert!(graph.incoming(&Address::box_of(MISSING)).is_empty());
    assert!(!graph.vertex_exists(&Address::box_of(MISSING)));
}

#[test]
fn two_pass_resolves_regardless_of_load_order() {
    let graph = BoxGraph::from_boxes(vec![
        node(0, A, 1, Some(Address::box_of(B))),
        node(5, B, 2, Some(Address::box_of(A)))
    ]);
    let bytes = graph.to_bytes();
    let reloaded = BoxGraph::from_bytes(&bytes, &registry()).unwrap();
    assert_eq!(reloaded.target_of(&Address::of(A, vec![1])), Some(&Address::box_of(B)));
    assert_eq!(reloaded.target_of(&Address::of(B, vec![1])), Some(&Address::box_of(A)));
    assert_eq!(reloaded.incoming(&Address::box_of(A)), vec![&Address::of(B, vec![1])]);
    assert!(reloaded.dangling().is_empty());
}

#[test]
fn vertex_exists_for_box_and_field() {
    let graph = BoxGraph::from_boxes(vec![node(0, A, 1, None)]);
    assert!(graph.vertex_exists(&Address::box_of(A)));
    assert!(graph.vertex_exists(&Address::of(A, vec![0])));
    assert!(graph.vertex_exists(&Address::of(A, vec![1])));
    assert!(!graph.vertex_exists(&Address::of(A, vec![9])));
    assert!(!graph.vertex_exists(&Address::box_of(B)));
}
