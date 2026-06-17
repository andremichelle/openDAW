//! Golden test against `test-files/all-boxes.od` — a TS-generated fixture containing one instance of
//! EVERY box type (pointers best-effort wired). Proves TS↔Rust byte parity across all box types,
//! not just the subset a real project happens to use.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use studio_boxes::registry;

const MAGIC_OPEN: i32 = 0x4F50_454E;
const FORMAT_VERSION: i32 = 2;

fn load_chunk() -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-files/all-boxes.od");
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"));
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(reader.read_int().unwrap(), MAGIC_OPEN, "magic OPEN");
    assert_eq!(reader.read_int().unwrap(), FORMAT_VERSION, "format version");
    let length = reader.read_int().unwrap() as usize;
    reader.read_raw(length).unwrap()
}

#[test]
fn every_registry_type_is_present() {
    let chunk = load_chunk();
    let registry = registry();
    let graph = BoxGraph::from_bytes(&chunk, &registry).expect("parse all-boxes graph");
    assert_eq!(graph.box_count(), registry.len(), "expected one box per registry type");
    let present: BTreeSet<&str> = graph.box_names().into_iter().collect();
    for name in registry.keys() {
        assert!(present.contains(name.as_str()), "missing box type in fixture: {name}");
    }
}

#[test]
fn all_boxes_round_trip_byte_identical() {
    let chunk = load_chunk();
    let graph = BoxGraph::from_bytes(&chunk, &registry()).unwrap();
    assert_eq!(graph.to_bytes(), chunk, "re-encoded all-boxes differs from source bytes");
}

#[test]
fn no_dangling_pointers() {
    let chunk = load_chunk();
    let graph = BoxGraph::from_bytes(&chunk, &registry()).unwrap();
    assert!(graph.dangling().is_empty(), "{} dangling pointer(s)", graph.dangling().len());
}
