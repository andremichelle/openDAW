//! The BoxGraph: a UUID→box map plus a resolved edge model. Mirrors lib-box `graph.ts` +
//! `graph-edges.ts`, but uses Rust-friendly ownership: boxes own their field values; pointers are
//! NOT object references but plain `Address` pairs in an edge list, with forward (source→target)
//! and incoming (target→sources) adjacency derived from them. Lookups go through the maps by key,
//! so nothing holds a borrow into another box. Loading is two-pass: insert all boxes, then resolve
//! edges (a pointer may target a box loaded earlier or later).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use crate::address::{Address, Uuid};
use crate::boxes::{GraphBox, Registry};
use crate::bytes::{ByteReader, ByteWriter};
use crate::field::FieldValue;
use crate::Error;

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub source: Address,         // address of the pointer field
    pub target: Option<Address>, // None = empty pointer
}

pub struct BoxGraph {
    boxes: BTreeMap<Uuid, GraphBox>,
    edges: Vec<Edge>,
    forward: BTreeMap<Address, usize>,        // pointer source → edge
    incoming: BTreeMap<Address, Vec<usize>>,  // target vertex → edges aimed at it (resolved only)
}

impl BoxGraph {
    pub fn from_boxes(boxes: Vec<GraphBox>) -> Self {
        let mut map = BTreeMap::new();
        for graph_box in boxes {
            map.insert(graph_box.uuid, graph_box);
        }
        let mut graph = Self {boxes: map, edges: Vec::new(), forward: BTreeMap::new(), incoming: BTreeMap::new()};
        graph.rebuild_edges();
        graph
    }

    pub fn from_bytes(bytes: &[u8], registry: &Registry) -> Result<Self, Error> {
        let mut reader = ByteReader::new(bytes);
        let count = reader.read_int()? as usize;
        let mut loaded: Vec<GraphBox> = Vec::with_capacity(count);
        for _ in 0..count {
            let length = reader.read_int()? as usize;
            let box_bytes = reader.read_raw(length)?;
            let mut box_reader = ByteReader::new(&box_bytes);
            loaded.push(GraphBox::read(&mut box_reader, registry)?);
        }
        loaded.sort_by_key(|graph_box| graph_box.creation_index);
        Ok(Self::from_boxes(loaded)) // pass 2 (edge resolution) happens once all boxes are present
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut writer = ByteWriter::new();
        writer.write_int(self.boxes.len() as i32);
        for graph_box in self.boxes.values() {
            let mut box_writer = ByteWriter::new();
            graph_box.serialize(&mut box_writer);
            let bytes = box_writer.into_bytes();
            writer.write_int(bytes.len() as i32);
            writer.write_raw(&bytes);
        }
        writer.into_bytes()
    }

    pub fn box_count(&self) -> usize {
        self.boxes.len()
    }

    pub fn find_box(&self, uuid: &Uuid) -> Option<&GraphBox> {
        self.boxes.get(uuid)
    }

    pub fn box_names(&self) -> Vec<&str> {
        self.boxes.values().map(|graph_box| graph_box.name.as_str()).collect()
    }

    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// The target a pointer field points at (if it has one).
    pub fn target_of(&self, source: &Address) -> Option<&Address> {
        self.forward.get(source).and_then(|&index| self.edges[index].target.as_ref())
    }

    /// Sources of the pointer fields aiming at `target` (resolved edges only).
    pub fn incoming(&self, target: &Address) -> Vec<&Address> {
        self.incoming
            .get(target)
            .map(|indices| indices.iter().map(|&index| &self.edges[index].source).collect())
            .unwrap_or_default()
    }

    /// Edges whose non-empty target does not resolve to an existing vertex (dangling pointers).
    pub fn dangling(&self) -> Vec<&Edge> {
        self.edges
            .iter()
            .filter(|edge| edge.target.as_ref().is_some_and(|target| !self.vertex_exists(target)))
            .collect()
    }

    /// Whether an address resolves to an existing vertex (a box, or a field path within one).
    pub fn vertex_exists(&self, address: &Address) -> bool {
        match self.boxes.get(&address.uuid) {
            None => false,
            Some(graph_box) => {
                if address.field_keys.is_empty() {
                    return true;
                }
                graph_box.fields
                    .get(&address.field_keys[0])
                    .is_some_and(|value| resolve_path(value, &address.field_keys[1..]).is_some())
            }
        }
    }

    fn rebuild_edges(&mut self) {
        let mut edges = Vec::new();
        for graph_box in self.boxes.values() {
            for (key, value) in &graph_box.fields {
                collect_pointers(graph_box.uuid, value, &[*key], &mut edges);
            }
        }
        let mut forward = BTreeMap::new();
        let mut incoming: BTreeMap<Address, Vec<usize>> = BTreeMap::new();
        for (index, edge) in edges.iter().enumerate() {
            forward.insert(edge.source.clone(), index);
            if let Some(target) = &edge.target {
                if self.vertex_exists(target) {
                    incoming.entry(target.clone()).or_default().push(index);
                }
            }
        }
        self.edges = edges;
        self.forward = forward;
        self.incoming = incoming;
    }
}

fn resolve_path<'a>(value: &'a FieldValue, keys: &[u16]) -> Option<&'a FieldValue> {
    if keys.is_empty() {
        return Some(value);
    }
    match value {
        FieldValue::Object(fields) => fields.get(&keys[0]).and_then(|child| resolve_path(child, &keys[1..])),
        FieldValue::Array(elements) => elements.get(keys[0] as usize).and_then(|child| resolve_path(child, &keys[1..])),
        _ => None
    }
}

fn collect_pointers(uuid: Uuid, value: &FieldValue, path: &[u16], out: &mut Vec<Edge>) {
    match value {
        FieldValue::Pointer(target) =>
            out.push(Edge {source: Address::of(uuid, path.to_vec()), target: target.clone()}),
        FieldValue::Object(fields) => {
            for (key, child) in fields {
                let mut child_path = path.to_vec();
                child_path.push(*key);
                collect_pointers(uuid, child, &child_path, out);
            }
        }
        FieldValue::Array(elements) => {
            for (index, child) in elements.iter().enumerate() {
                let mut child_path = path.to_vec();
                child_path.push(index as u16);
                collect_pointers(uuid, child, &child_path, out);
            }
        }
        _ => {}
    }
}
