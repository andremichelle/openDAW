//! Loads a real openDAW project (`test-files/openup.od`) through the generated registry and the
//! generic boxgraph reader, and validates it — culminating in a golden byte-for-byte round-trip.

use std::fs;
use std::path::Path;
use boxgraph::bytes::ByteReader;
use boxgraph::field::{FieldValue, Fields};
use boxgraph::graph::BoxGraph;
use studio_boxes::registry;

const MAGIC_OPEN: i32 = 0x4F50_454E; // "OPEN"
const FORMAT_VERSION: i32 = 2;

/// Strip the ProjectSkeleton wrapper (`OPEN` + version + chunk-len) and return the box-graph chunk.
fn load_chunk() -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-files/openup.od");
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"));
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(reader.read_int().unwrap(), MAGIC_OPEN, "magic OPEN");
    assert_eq!(reader.read_int().unwrap(), FORMAT_VERSION, "format version");
    let length = reader.read_int().unwrap() as usize;
    reader.read_raw(length).unwrap()
}

#[test]
fn loads_real_project() {
    let graph = BoxGraph::from_bytes(&load_chunk(), &registry()).expect("parse box graph");
    assert!(graph.box_count() > 0, "expected boxes");
    println!("loaded {} boxes", graph.box_count());
}

#[test]
fn no_dangling_pointers() {
    let graph = BoxGraph::from_bytes(&load_chunk(), &registry()).unwrap();
    let dangling = graph.dangling();
    assert!(dangling.is_empty(), "{} dangling pointer(s), first: {:?}", dangling.len(), dangling.first());
}

fn field(fields: &Fields, key: u16) -> &FieldValue {
    fields.get(&key).unwrap_or_else(|| panic!("no field {key}"))
}

// Real decoded values from openup.od, cross-checked against the TS reference (Box.toJSON).

#[test]
fn root_box_values() {
    let graph = BoxGraph::from_bytes(&load_chunk(), &registry()).unwrap();
    let root = graph.find_by_name("RootBox").expect("RootBox");
    assert_eq!(field(&root.fields, 5), &FieldValue::Float32(440.0)); // A4 tuning reference (not bpm)
    assert_eq!(field(&root.fields, 3), &FieldValue::String("2026-03-24T18:29:55.811Z".to_string()));
    let FieldValue::Object(inner) = field(&root.fields, 40) else {panic!("key 40 is not an object")};
    assert_eq!(field(inner, 1), &FieldValue::Int32(0));
    assert_eq!(field(inner, 2), &FieldValue::Float32(8.0));
    assert_eq!(field(inner, 3), &FieldValue::Float32(1.0));
    assert_eq!(field(inner, 4), &FieldValue::Boolean(false));
    assert_eq!(field(inner, 5), &FieldValue::Int32(0));
}

#[test]
fn project_meta_values() {
    let graph = BoxGraph::from_bytes(&load_chunk(), &registry()).unwrap();
    let meta = graph.find_by_name("ProjectMetaBox").expect("ProjectMetaBox");
    assert_eq!(field(&meta.fields, 1), &FieldValue::String("Open Up".to_string()));
    assert_eq!(field(&meta.fields, 2), &FieldValue::String("Ilir Bajri".to_string()));
    assert_eq!(field(&meta.fields, 3), &FieldValue::String("My first take at openDAW".to_string()));
}

#[test]
fn timeline_box_values() {
    let graph = BoxGraph::from_bytes(&load_chunk(), &registry()).unwrap();
    let timeline = graph.find_by_name("TimelineBox").expect("TimelineBox");
    assert_eq!(field(&timeline.fields, 31), &FieldValue::Float32(140.0)); // bpm
    assert_eq!(field(&timeline.fields, 30), &FieldValue::Int32(491520)); // durationInPulses
    let FieldValue::Object(signature) = field(&timeline.fields, 10) else {panic!("key 10 is not an object")};
    assert_eq!(field(signature, 1), &FieldValue::Int32(4)); // nominator
    assert_eq!(field(signature, 2), &FieldValue::Int32(4)); // denominator
}

#[test]
fn golden_round_trip_byte_identical() {
    let chunk = load_chunk();
    let graph = BoxGraph::from_bytes(&chunk, &registry()).unwrap();
    let reencoded = graph.to_bytes();
    assert_eq!(reencoded.len(), chunk.len(), "re-encoded length differs from source");
    assert!(reencoded == chunk, "re-encoded box graph differs from source bytes");
}
