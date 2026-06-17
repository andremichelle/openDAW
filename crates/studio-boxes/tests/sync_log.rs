//! Golden replay of a recorded Sync Log Stream (`test-files/actions.odsl`): an Init commit (a full
//! project) followed by Updates commits (the delta stream). Verifies the commit hash-chain ("check
//! uuids"), loads the Init project, and replays every update through the live-mirror transaction
//! API — exercising the real recorded update stream end to end.

use std::fs;
use std::path::Path;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates;
use studio_boxes::registry;

const MAGIC_OPEN: i32 = 0x4F50_454E;
const COMMIT_INIT: i32 = 0;
const COMMIT_UPDATES: i32 = 2;

struct Commit {
    commit_type: i32,
    prev_hash: Vec<u8>,
    this_hash: Vec<u8>,
    payload: Vec<u8>
}

fn read_commits(bytes: &[u8]) -> Vec<Commit> {
    let mut reader = ByteReader::new(bytes);
    let mut commits = Vec::new();
    while reader.remaining() > 0 {
        let commit_type = reader.read_int().unwrap();
        assert_eq!(reader.read_int().unwrap(), 1, "commit version");
        let prev_hash = reader.read_raw(32).unwrap();
        let this_hash = reader.read_raw(32).unwrap();
        let length = reader.read_int().unwrap() as usize;
        let payload = reader.read_raw(length).unwrap();
        reader.read_double().unwrap(); // date
        commits.push(Commit {commit_type, prev_hash, this_hash, payload});
    }
    commits
}

/// The Init payload is a ProjectSkeleton (OPEN + version + chunk-len + box-graph chunk).
fn box_graph_chunk(project_payload: &[u8]) -> Vec<u8> {
    let mut reader = ByteReader::new(project_payload);
    assert_eq!(reader.read_int().unwrap(), MAGIC_OPEN, "init payload is a project");
    reader.read_int().unwrap(); // format version
    let length = reader.read_int().unwrap() as usize;
    reader.read_raw(length).unwrap()
}

#[test]
fn replays_recorded_sync_log() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-files/actions.odsl");
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"));
    let commits = read_commits(&bytes);
    assert!(commits.len() >= 2, "expected an Init commit plus updates");

    // chain integrity ("check uuids"): first links to the empty hash, each to the previous hash
    assert_eq!(commits[0].commit_type, COMMIT_INIT, "first commit is Init");
    assert_eq!(commits[0].prev_hash, vec![0u8; 32], "first commit links to empty hash");
    for pair in commits.windows(2) {
        assert_eq!(pair[1].prev_hash, pair[0].this_hash, "broken commit hash chain");
    }

    let registry = registry();
    let mut graph = BoxGraph::from_bytes(&box_graph_chunk(&commits[0].payload), &registry)
        .expect("load Init project");
    let initial_boxes = graph.box_count();

    let mut applied = 0usize;
    for commit in &commits[1..] {
        if commit.commit_type == COMMIT_UPDATES {
            let mut reader = ByteReader::new(&commit.payload);
            let updates = updates::decode(&mut reader).expect("decode updates");
            graph.transaction(&updates, &registry).expect("apply updates");
            applied += updates.len();
        }
    }

    assert!(applied > 0, "expected at least one update in the log");
    assert!(graph.dangling().is_empty(), "{} dangling pointer(s) after replay", graph.dangling().len());
    println!("replayed {applied} updates over {} commits; boxes {initial_boxes} -> {}",
        commits.len(), graph.box_count());
}
