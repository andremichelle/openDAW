//! The incremental NoteCollection observer: initial build via the pointer-hub catch-up, insert on a
//! new member, remove on disconnect, re-read on a member edit, and an unrelated edit left untouched.

use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::field::{FieldValue, Fields};
use boxgraph::graph::BoxGraph;
use boxgraph::updates::Update;
use bindings::note_collection::NoteCollection;

const COLLECTION: Uuid = [1u8; 16];
const NOTE_A: Uuid = [2u8; 16];
const NOTE_B: Uuid = [3u8; 16];
const OTHER: Uuid = [9u8; 16];

fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
    let mut map = Fields::new();
    for (key, value) in fields {
        map.insert(*key, value.clone());
    }
    GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
}

fn collection_box() -> GraphBox {
    graph_box(COLLECTION, "NoteEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)])
}

/// A NoteEventBox; `events` (1) points at the collection hub when `member`.
fn note_box(uuid: Uuid, position: i32, pitch: i32, member: bool) -> GraphBox {
    let events = if member {FieldValue::Pointer(Some(Address::of(COLLECTION, vec![1])))} else {FieldValue::Pointer(None)};
    graph_box(uuid, "NoteEventBox", &[
        (1, events),
        (10, FieldValue::Int32(position)),
        (11, FieldValue::Int32(240)),
        (20, FieldValue::Int32(pitch)),
        (21, FieldValue::Float32(0.8)),
        (24, FieldValue::Float32(0.0))
    ])
}

fn pitches(collection: &NoteCollection) -> Vec<u8> {
    collection.events().as_slice().iter().map(|note| note.pitch).collect()
}

#[test]
fn observes_initial_notes_sorted() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), note_box(NOTE_A, 480, 64, true), note_box(NOTE_B, 0, 60, true)]);
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    assert_eq!(pitches(&collection), vec![60, 64]); // sorted by position
}

#[test]
fn inserts_on_new_member_and_removes_on_disconnect() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), note_box(NOTE_A, 0, 60, true), note_box(NOTE_B, 480, 64, false)]);
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    assert_eq!(collection.len(), 1);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(NOTE_B, vec![1]),
        old: None,
        new: Some(Address::of(COLLECTION, vec![1]))
    }], &registry).unwrap();
    assert_eq!(collection.len(), 2, "connecting a note inserts it");
    graph.transaction(&[Update::Pointer {
        address: Address::of(NOTE_A, vec![1]),
        old: Some(Address::of(COLLECTION, vec![1])),
        new: None
    }], &registry).unwrap();
    assert_eq!(pitches(&collection), vec![64], "disconnecting a note removes it");
}

#[test]
fn re_reads_on_a_member_pitch_edit() {
    let mut graph = BoxGraph::from_boxes(vec![collection_box(), note_box(NOTE_A, 0, 60, true)]);
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(NOTE_A, vec![20]),
        old: FieldValue::Int32(60),
        new: FieldValue::Int32(72)
    }], &registry).unwrap();
    assert_eq!(pitches(&collection), vec![72]);
}

#[test]
fn an_unrelated_edit_leaves_the_collection_untouched() {
    let mut graph = BoxGraph::from_boxes(vec![
        collection_box(),
        note_box(NOTE_A, 0, 60, true),
        graph_box(OTHER, "RootBox", &[(5, FieldValue::Float32(440.0))])
    ]);
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(OTHER, vec![5]),
        old: FieldValue::Float32(440.0),
        new: FieldValue::Float32(432.0)
    }], &registry).unwrap();
    assert_eq!(pitches(&collection), vec![60]);
}
