//! The incremental ValueCollection observer: initial build (via the pointer-hub catch-up), insert on
//! a new member, remove on disconnect, re-read on a value edit, re-sort on a position edit, an
//! unrelated edit leaving it untouched, and curve attach + slope edits resolving through the curve box.

use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::field::{FieldValue, Fields};
use boxgraph::graph::BoxGraph;
use boxgraph::updates::Update;
use bindings::value_collection::ValueCollection;
use value::value::Interpolation;

const COLLECTION: Uuid = [1u8; 16];
const EVENT_A: Uuid = [2u8; 16];
const EVENT_B: Uuid = [3u8; 16];
const CURVE: Uuid = [4u8; 16];
const OTHER: Uuid = [9u8; 16];

fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
    let mut map = Fields::new();
    for (key, value) in fields {
        map.insert(*key, value.clone());
    }
    GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
}

fn collection_box() -> GraphBox {
    graph_box(COLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)])
}

/// A ValueEventBox; `events` points at the collection hub when `member`, otherwise empty.
fn event_box(uuid: Uuid, position: i32, value: f32, member: bool) -> GraphBox {
    let events = if member {FieldValue::Pointer(Some(Address::of(COLLECTION, vec![1])))} else {FieldValue::Pointer(None)};
    graph_box(uuid, "ValueEventBox", &[
        (1, events),
        (10, FieldValue::Int32(position)),
        (11, FieldValue::Int32(0)),
        (12, FieldValue::Int32(1)),
        (13, FieldValue::Float32(value))
    ])
}

#[test]
fn observes_initial_events() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), event_box(EVENT_A, 0, 100.0, true), event_box(EVENT_B, 960, 110.0, true)]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    let values: Vec<f32> = collection.events().as_slice().iter().map(|event| event.value).collect();
    assert_eq!(values, vec![100.0, 110.0]);
}

#[test]
fn re_reads_on_member_value_edit() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), event_box(EVENT_A, 0, 100.0, true)]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(EVENT_A, vec![13]),
        old: FieldValue::Float32(100.0),
        new: FieldValue::Float32(140.0)
    }], &registry).unwrap();
    assert_eq!(collection.events().as_slice()[0].value, 140.0, "the value edit re-reads the event in place");
}

#[test]
fn re_sorts_on_member_position_edit() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), event_box(EVENT_A, 0, 100.0, true), event_box(EVENT_B, 960, 110.0, true)]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(EVENT_A, vec![10]),
        old: FieldValue::Int32(0),
        new: FieldValue::Int32(1920)
    }], &registry).unwrap();
    let positions: Vec<f64> = collection.events().as_slice().iter().map(|event| event.position).collect();
    assert_eq!(positions, vec![960.0, 1920.0], "the moved event re-sorts to the right place");
}

#[test]
fn inserts_on_new_member() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), event_box(EVENT_A, 0, 100.0, true), event_box(EVENT_B, 960, 110.0, false)]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    assert_eq!(collection.len(), 1);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(EVENT_B, vec![1]),
        old: None,
        new: Some(Address::of(COLLECTION, vec![1]))
    }], &registry).unwrap();
    assert_eq!(collection.len(), 2, "connecting a new event inserts it (pointer-hub Added)");
}

#[test]
fn removes_on_disconnect() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), event_box(EVENT_A, 0, 100.0, true)]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    assert_eq!(collection.len(), 1);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(EVENT_A, vec![1]),
        old: Some(Address::of(COLLECTION, vec![1])),
        new: None
    }], &registry).unwrap();
    assert!(collection.is_empty(), "disconnecting the only member empties the collection");
}

#[test]
fn unrelated_edit_leaves_collection_untouched() {
    let mut graph = BoxGraph::from_boxes(vec![
        collection_box(),
        event_box(EVENT_A, 0, 100.0, true),
        graph_box(OTHER, "RootBox", &[(5, FieldValue::Float32(440.0))])
    ]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(OTHER, vec![5]),
        old: FieldValue::Float32(440.0),
        new: FieldValue::Float32(432.0)
    }], &registry).unwrap();
    assert_eq!(collection.len(), 1);
    assert_eq!(collection.events().as_slice()[0].value, 100.0, "an edit to a non-member box must not touch the collection");
}

#[test]
fn curve_attach_and_slope_edit_resolve_through_the_curve_box() {
    let mut graph = BoxGraph::from_boxes(vec![
        collection_box(),
        // EVENT_A interpolation field 0 (none); the curve box exists but is not attached yet
        graph_box(EVENT_A, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(COLLECTION, vec![1])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(0)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Float32(100.0))
        ]),
        graph_box(CURVE, "ValueEventCurveBox", &[(1, FieldValue::Pointer(None)), (2, FieldValue::Float32(0.3))])
    ]);
    let collection = ValueCollection::observe(&mut graph, COLLECTION);
    assert_eq!(collection.events().as_slice()[0].interpolation, Interpolation::None);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(CURVE, vec![1]),
        old: None,
        new: Some(Address::of(EVENT_A, vec![12]))
    }], &registry).unwrap();
    assert_eq!(collection.events().as_slice()[0].interpolation, Interpolation::Curve(0.3), "attaching the curve re-reads the event as a curve");
    graph.transaction(&[Update::Primitive {
        address: Address::of(CURVE, vec![2]),
        old: FieldValue::Float32(0.3),
        new: FieldValue::Float32(0.7)
    }], &registry).unwrap();
    assert_eq!(collection.events().as_slice()[0].interpolation, Interpolation::Curve(0.7), "a slope edit maps back through box_to_event");
}
