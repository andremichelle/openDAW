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
        (24, FieldValue::Float32(0.0)),
        (30, FieldValue::Hook),
        (31, FieldValue::Hook)
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

const CHANCE_A: Uuid = [4u8; 16];
const CHANCE_B: Uuid = [5u8; 16];
const GROUP: Uuid = [6u8; 16];
const REPEAT_A: Uuid = [7u8; 16];

fn chance_box(uuid: Uuid, note: Uuid, chance: i32, group: Option<Uuid>) -> GraphBox {
    graph_box(uuid, "NoteEventChanceBox", &[
        (1, FieldValue::Pointer(Some(Address::of(note, vec![30])))),
        (2, FieldValue::Int32(chance)),
        (3, FieldValue::Pointer(group.map(Address::box_of)))
    ])
}

fn group_box(chance: i32, mode: i32) -> GraphBox {
    graph_box(GROUP, "NoteEventChanceGroupBox", &[(1, FieldValue::Int32(chance)), (2, FieldValue::Int32(mode))])
}

fn repeat_box(note: Uuid, count: i32) -> GraphBox {
    graph_box(REPEAT_A, "NoteEventRepeatBox", &[
        (1, FieldValue::Pointer(Some(Address::of(note, vec![31])))),
        (2, FieldValue::Int32(count)),
        (3, FieldValue::Float32(0.25)),
        (4, FieldValue::Float32(0.5)),
        (5, FieldValue::Float32(-1.0))
    ])
}

fn grouped_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        collection_box(),
        note_box(NOTE_A, 0, 60, true),
        note_box(NOTE_B, 0, 64, true),
        group_box(40, 1),
        chance_box(CHANCE_A, NOTE_A, 70, Some(GROUP)),
        chance_box(CHANCE_B, NOTE_B, 80, Some(GROUP)),
        repeat_box(NOTE_A, 3)
    ])
}

fn note(collection: &NoteCollection, pitch: u8) -> value::note::NoteEvent {
    *collection.events().as_slice().iter().find(|note| note.pitch == pitch).expect("note")
}

#[test]
fn reads_chance_group_and_repeat_boxes() {
    let mut graph = grouped_graph();
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let first = note(&collection, 60);
    let second = note(&collection, 64);
    assert_eq!(first.chance, 70.0);
    assert_eq!(second.chance, 80.0);
    let group = first.group.expect("group");
    assert_eq!(group.chance, 40.0);
    assert!(group.play_one);
    assert_eq!((group.rank, group.size), (0, 2));
    assert_eq!(second.group.expect("group").rank, 1);
    assert_eq!(group.key, second.group.expect("group").key);
    assert_ne!(first.key, second.key);
    assert_eq!((first.play_count, first.play_curve, first.repeat_length, first.velocity_fade), (3, 0.25, 0.5, -1.0));
    assert_eq!(second.play_count, 1, "no repeat box: plays once");
}

#[test]
fn re_reads_every_member_on_a_group_edit() {
    let mut graph = grouped_graph();
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(GROUP, vec![1]),
        old: FieldValue::Int32(40),
        new: FieldValue::Int32(90)
    }], &registry).unwrap();
    assert_eq!(note(&collection, 60).group.expect("group").chance, 90.0);
    assert_eq!(note(&collection, 64).group.expect("group").chance, 90.0);
}

#[test]
fn re_reads_on_a_repeat_edit() {
    let mut graph = grouped_graph();
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Primitive {
        address: Address::of(REPEAT_A, vec![2]),
        old: FieldValue::Int32(3),
        new: FieldValue::Int32(8)
    }], &registry).unwrap();
    assert_eq!(note(&collection, 60).play_count, 8);
}

#[test]
fn leaving_the_group_updates_both_notes() {
    let mut graph = grouped_graph();
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(CHANCE_B, vec![3]),
        old: Some(Address::box_of(GROUP)),
        new: None
    }], &registry).unwrap();
    assert!(note(&collection, 64).group.is_none(), "the note left");
    assert_eq!(note(&collection, 64).chance, 80.0, "its own chance applies again");
    assert_eq!(note(&collection, 60).group.expect("group").size, 1, "the remaining member sees one member");
}

#[test]
fn detaching_the_chance_box_restores_chance_100() {
    let mut graph = grouped_graph();
    let collection = NoteCollection::observe(&mut graph, COLLECTION);
    let registry = Registry::new();
    graph.transaction(&[Update::Pointer {
        address: Address::of(CHANCE_A, vec![1]),
        old: Some(Address::of(NOTE_A, vec![30])),
        new: None
    }], &registry).unwrap();
    let first = note(&collection, 60);
    assert_eq!(first.chance, 100.0);
    assert!(first.group.is_none());
}
