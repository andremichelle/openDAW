//! Loads a real openDAW project (`test-files/openup.od`) through the generated registry and the
//! generic boxgraph reader, and validates it — culminating in a golden byte-for-byte round-trip.

use std::fs;
use std::path::Path;
use boxgraph::bytes::ByteReader;
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

#[test]
fn golden_round_trip_byte_identical() {
    let chunk = load_chunk();
    let graph = BoxGraph::from_bytes(&chunk, &registry()).unwrap();
    let reencoded = graph.to_bytes();
    assert_eq!(reencoded.len(), chunk.len(), "re-encoded length differs from source");
    assert!(reencoded == chunk, "re-encoded box graph differs from source bytes");
}
