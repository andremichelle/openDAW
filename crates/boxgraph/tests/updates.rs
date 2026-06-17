use std::collections::BTreeMap;
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::bytes::{ByteReader, ByteWriter};
use boxgraph::field::{write_fields, FieldType, FieldValue, Fields, Schema};
use boxgraph::graph::BoxGraph;
use boxgraph::updates;
use boxgraph::updates::Update;

const A: Uuid = [0xA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const B: Uuid = [0xB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const C: Uuid = [0xC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// "Node": int at key 0, pointer at key 1.
fn registry() -> Registry {
    Registry::from([("Node".to_string(), Schema::from([(0, FieldType::Int32), (1, FieldType::Pointer)]))])
}

fn node(creation_index: i32, uuid: Uuid, value: i32, pointer: Option<Address>) -> GraphBox {
    GraphBox {
        creation_index,
        name: "Node".to_string(),
        uuid,
        fields: BTreeMap::from([(0, FieldValue::Int32(value)), (1, FieldValue::Pointer(pointer))])
    }
}

fn node_settings(value: i32, pointer: Option<Address>) -> Vec<u8> {
    let fields: Fields = BTreeMap::from([(0, FieldValue::Int32(value)), (1, FieldValue::Pointer(pointer))]);
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, &fields);
    writer.into_bytes()
}

#[test]
fn wire_round_trip_all_kinds() {
    let updates = vec![
        Update::New {uuid: A, name: "Node".to_string(), settings: node_settings(7, None)},
        Update::Primitive {address: Address::of(A, vec![0]), old: FieldValue::Int32(7), new: FieldValue::Int32(9)},
        Update::Pointer {address: Address::of(A, vec![1]), old: None, new: Some(Address::box_of(B))},
        Update::Delete {uuid: A, name: "Node".to_string(), settings: node_settings(9, None)}
    ];
    let mut writer = ByteWriter::new();
    updates::encode(&mut writer, &updates);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(updates::decode(&mut reader).unwrap(), updates);
    assert_eq!(reader.remaining(), 0);
}

#[test]
fn apply_new_creates_box() {
    let mut graph = BoxGraph::from_boxes(vec![]);
    graph.transaction(
        &[Update::New {uuid: A, name: "Node".to_string(), settings: node_settings(42, None)}],
        &registry()).unwrap();
    assert_eq!(graph.box_count(), 1);
    assert_eq!(graph.find_box(&A).unwrap().fields.get(&0), Some(&FieldValue::Int32(42)));
}

#[test]
fn apply_primitive_sets_value() {
    let mut graph = BoxGraph::from_boxes(vec![node(0, A, 1, None)]);
    graph.transaction(
        &[Update::Primitive {address: Address::of(A, vec![0]), old: FieldValue::Int32(1), new: FieldValue::Int32(99)}],
        &registry()).unwrap();
    assert_eq!(graph.find_box(&A).unwrap().fields.get(&0), Some(&FieldValue::Int32(99)));
}

#[test]
fn apply_pointer_creates_resolved_edge() {
    let mut graph = BoxGraph::from_boxes(vec![node(0, A, 1, None), node(1, B, 2, None)]);
    graph.transaction(
        &[Update::Pointer {address: Address::of(A, vec![1]), old: None, new: Some(Address::box_of(B))}],
        &registry()).unwrap();
    assert_eq!(graph.target_of(&Address::of(A, vec![1])), Some(&Address::box_of(B)));
    assert_eq!(graph.incoming(&Address::box_of(B)), vec![&Address::of(A, vec![1])]);
}

#[test]
fn apply_delete_removes_box() {
    let mut graph = BoxGraph::from_boxes(vec![node(0, A, 1, None)]);
    graph.transaction(
        &[Update::Delete {uuid: A, name: "Node".to_string(), settings: node_settings(1, None)}],
        &registry()).unwrap();
    assert_eq!(graph.box_count(), 0);
    assert!(graph.find_box(&A).is_none());
}

#[test]
fn abort_restores_original_exactly() {
    let registry = registry();
    let original = BoxGraph::from_boxes(vec![node(0, A, 1, None), node(1, B, 2, None)]).to_bytes();
    let mut graph = BoxGraph::from_boxes(vec![node(0, A, 1, None), node(1, B, 2, None)]);
    let updates = vec![
        Update::Primitive {address: Address::of(A, vec![0]), old: FieldValue::Int32(1), new: FieldValue::Int32(50)},
        Update::Pointer {address: Address::of(A, vec![1]), old: None, new: Some(Address::box_of(B))},
        Update::New {uuid: C, name: "Node".to_string(), settings: node_settings(5, None)}
    ];
    graph.transaction(&updates, &registry).unwrap();
    assert_ne!(graph.to_bytes(), original, "transaction should change the graph");
    graph.abort(&updates, &registry).unwrap();
    assert_eq!(graph.to_bytes(), original, "abort should restore the original bytes exactly");
}
