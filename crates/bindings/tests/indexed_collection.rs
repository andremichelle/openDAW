//! The IndexedCollection binder: device boxes connected to a host field are ordered by their `index`,
//! caught up on observe, kept in order as members connect / disconnect, and re-sorted when an index edits.
//! Mirrors how an audio unit's midi-effects / audio-effects chain is ordered (TS IndexedBoxAdapterCollection).

use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::field::{FieldValue, Fields};
use boxgraph::graph::BoxGraph;
use boxgraph::updates::Update;
use bindings::indexed_collection::IndexedCollection;

const UNIT: Uuid = [1u8; 16];
const HOST_KEY: u16 = 21; // AudioUnitBox.midi-effects
const INDEX_KEY: u16 = 2; // device.index
const DEV_A: Uuid = [10u8; 16];
const DEV_B: Uuid = [11u8; 16];
const DEV_C: Uuid = [12u8; 16];

fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
    let mut map = Fields::new();
    for (key, value) in fields {
        map.insert(*key, value.clone());
    }
    GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
}

fn unit_box() -> GraphBox {
    graph_box(UNIT, "AudioUnitBox", &[(HOST_KEY, FieldValue::Hook)])
}

/// A device box: `host` (1) points at the unit's host hub when `member`, `index` (2) is its chain position.
fn device_box(uuid: Uuid, index: i32, member: bool) -> GraphBox {
    let host = if member {FieldValue::Pointer(Some(Address::of(UNIT, vec![HOST_KEY])))} else {FieldValue::Pointer(None)};
    graph_box(uuid, "ArpeggioDeviceBox", &[(1, host), (INDEX_KEY, FieldValue::Int32(index))])
}

fn host() -> Address {
    Address::of(UNIT, vec![HOST_KEY])
}

#[test]
fn orders_initial_members_by_index() {
    // Added out of index order; observe must sort by index (B=0, A=1, C=2).
    let graph = &mut BoxGraph::from_boxes(vec![
        unit_box(),
        device_box(DEV_A, 1, true),
        device_box(DEV_B, 0, true),
        device_box(DEV_C, 2, true)
    ]);
    let chain = IndexedCollection::observe(graph, host(), INDEX_KEY);
    assert_eq!(chain.sorted(), vec![DEV_B, DEV_A, DEV_C]);
    assert_eq!(chain.sorted_indices(), vec![0, 1, 2]);
}

#[test]
fn reacts_to_connect_and_disconnect() {
    let graph = &mut BoxGraph::from_boxes(vec![
        unit_box(),
        device_box(DEV_A, 0, true),
        device_box(DEV_B, 1, false) // not yet connected
    ]);
    let chain = IndexedCollection::observe(graph, host(), INDEX_KEY);
    assert_eq!(chain.len(), 1);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(DEV_B, vec![1]),
        old: None,
        new: Some(host())
    }], &registry).unwrap();
    assert_eq!(chain.sorted(), vec![DEV_A, DEV_B], "connecting a device adds it in index order");
    graph.transaction(&[Update::Pointer {
        address: Address::of(DEV_A, vec![1]),
        old: Some(host()),
        new: None
    }], &registry).unwrap();
    assert_eq!(chain.sorted(), vec![DEV_B], "disconnecting removes it");
}

#[test]
fn dirty_is_raised_only_on_a_real_change() {
    let graph = &mut BoxGraph::from_boxes(vec![
        unit_box(),
        device_box(DEV_A, 0, true),
        device_box(DEV_B, 1, true),
        graph_box([9u8; 16], "RootBox", &[(5, FieldValue::Float32(440.0))])
    ]);
    let chain = IndexedCollection::observe(graph, host(), INDEX_KEY);
    assert!(chain.take_dirty(), "catch-up of initial members is a change");
    assert!(!chain.take_dirty(), "consumed; nothing changed since");
    let registry = Registry::new();
    // An unrelated edit must NOT dirty the chain.
    graph.transaction(&[Update::Primitive {
        address: Address::of([9u8; 16], vec![5]),
        old: FieldValue::Float32(440.0),
        new: FieldValue::Float32(432.0)
    }], &registry).unwrap();
    assert!(!chain.take_dirty(), "an unrelated edit leaves the chain clean");
    // Re-setting a member's index to the SAME value must NOT dirty it.
    graph.transaction(&[Update::Primitive {
        address: Address::of(DEV_A, vec![INDEX_KEY]),
        old: FieldValue::Int32(0),
        new: FieldValue::Int32(0)
    }], &registry).unwrap();
    assert!(!chain.take_dirty(), "an index edit that does not change the value is not a reorder");
    // A real index change dirties it.
    graph.transaction(&[Update::Primitive {
        address: Address::of(DEV_A, vec![INDEX_KEY]),
        old: FieldValue::Int32(0),
        new: FieldValue::Int32(5)
    }], &registry).unwrap();
    assert!(chain.take_dirty(), "a real index change dirties the chain");
}

#[test]
fn re_sorts_when_an_index_changes() {
    let graph = &mut BoxGraph::from_boxes(vec![
        unit_box(),
        device_box(DEV_A, 0, true),
        device_box(DEV_B, 1, true)
    ]);
    let chain = IndexedCollection::observe(graph, host(), INDEX_KEY);
    assert_eq!(chain.sorted(), vec![DEV_A, DEV_B]);
    let registry = Registry::new();
    // Move A behind B by raising its index (the reorder edit the chain must respect every time).
    graph.transaction(&[Update::Primitive {
        address: Address::of(DEV_A, vec![INDEX_KEY]),
        old: FieldValue::Int32(0),
        new: FieldValue::Int32(2)
    }], &registry).unwrap();
    assert_eq!(chain.sorted(), vec![DEV_B, DEV_A], "raising A's index moves it after B");
    assert_eq!(chain.sorted_indices(), vec![1, 2]);
}
