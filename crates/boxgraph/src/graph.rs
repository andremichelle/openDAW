//! The BoxGraph: a UUID→box map plus a resolved edge model. Mirrors lib-box `graph.ts` +
//! `graph-edges.ts`, but uses Rust-friendly ownership: boxes own their field values; pointers are
//! NOT object references but plain `Address` pairs in an edge list, with forward (source→target)
//! and incoming (target→sources) adjacency derived from them. Lookups go through the maps by key,
//! so nothing holds a borrow into another box. Loading is two-pass: insert all boxes, then resolve
//! edges (a pointer may target a box loaded earlier or later).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use crate::address::{Address, Uuid};
use alloc::string::ToString;
use crate::boxes::{GraphBox, Registry};
use crate::bytes::{ByteReader, ByteWriter};
use crate::checksum::{checksum_fields, Checksum};
use crate::field::{read_fields, FieldValue};
use crate::subscription::{Propagation, SubscriptionId, Subscriptions, UpdateObserver};
use crate::updates::Update;
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
    next_index: i32,                          // creation index for boxes created via updates
    subscriptions: Subscriptions,             // change listeners notified during a transaction
}

impl BoxGraph {
    pub fn from_boxes(boxes: Vec<GraphBox>) -> Self {
        let mut map = BTreeMap::new();
        for graph_box in boxes {
            map.insert(graph_box.uuid, graph_box);
        }
        let next_index = map.values().map(|graph_box| graph_box.creation_index).max().map_or(0, |max| max + 1);
        let mut graph = Self {
            boxes: map, edges: Vec::new(), forward: BTreeMap::new(), incoming: BTreeMap::new(), next_index,
            subscriptions: Subscriptions::new()
        };
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

    /// First box with the given type name (useful for singleton boxes like RootBox).
    pub fn find_by_name(&self, name: &str) -> Option<&GraphBox> {
        self.boxes.values().find(|graph_box| graph_box.name == name)
    }

    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// 32-byte rolling XOR checksum over every box's fields (uuid order), matching `BoxGraph.checksum`.
    pub fn checksum(&self) -> [u8; 32] {
        let mut checksum = Checksum::new();
        for graph_box in self.boxes.values() {
            checksum_fields(&mut checksum, &graph_box.fields);
        }
        checksum.result()
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

    // ---- Mutation (the live-mirror update stream; see the `updates` module) ----

    /// Apply a transaction: each update forward (then dispatched to subscribers), edges rebuilt once.
    pub fn transaction(&mut self, updates: &[Update], registry: &Registry) -> Result<(), Error> {
        for update in updates {
            self.apply(update, registry)?;
            self.subscriptions.dispatch(update);
        }
        self.rebuild_edges();
        Ok(())
    }

    /// Subscribe to every applied update. Returns a handle for `unsubscribe`.
    pub fn subscribe_all(&mut self, observer: UpdateObserver) -> SubscriptionId {
        self.subscriptions.subscribe_all(observer)
    }

    /// Subscribe to updates at `address`, filtered by `propagation` (This / Parent / Children).
    pub fn subscribe_vertex(&mut self, propagation: Propagation, address: Address, observer: UpdateObserver) -> SubscriptionId {
        self.subscriptions.subscribe_vertex(propagation, address, observer)
    }

    /// Remove a subscription, dropping its observer. Returns whether one was removed.
    pub fn unsubscribe(&mut self, id: SubscriptionId) -> bool {
        self.subscriptions.unsubscribe(id)
    }

    pub fn subscription_count(&self) -> usize {
        self.subscriptions.count()
    }

    /// Undo a transaction: each update's inverse in reverse order, then edges rebuilt.
    pub fn abort(&mut self, updates: &[Update], registry: &Registry) -> Result<(), Error> {
        for update in updates.iter().rev() {
            self.revert(update, registry)?;
        }
        self.rebuild_edges();
        Ok(())
    }

    fn apply(&mut self, update: &Update, registry: &Registry) -> Result<(), Error> {
        match update {
            Update::New {uuid, name, settings} => self.create_box(*uuid, name, settings, registry),
            Update::Delete {uuid, ..} => {self.boxes.remove(uuid); Ok(())}
            Update::Primitive {address, new, ..} => self.set_field(address, new.clone()),
            Update::Pointer {address, new, ..} => self.set_field(address, FieldValue::Pointer(new.clone()))
        }
    }

    fn revert(&mut self, update: &Update, registry: &Registry) -> Result<(), Error> {
        match update {
            Update::New {uuid, ..} => {self.boxes.remove(uuid); Ok(())}
            Update::Delete {uuid, name, settings} => self.create_box(*uuid, name, settings, registry),
            Update::Primitive {address, old, ..} => self.set_field(address, old.clone()),
            Update::Pointer {address, old, ..} => self.set_field(address, FieldValue::Pointer(old.clone()))
        }
    }

    fn create_box(&mut self, uuid: Uuid, name: &str, settings: &[u8], registry: &Registry) -> Result<(), Error> {
        let schema = registry.get(name).ok_or(Error::UnknownBox)?;
        let mut reader = ByteReader::new(settings);
        let fields = read_fields(&mut reader, schema)?;
        let creation_index = self.next_index;
        self.next_index += 1;
        self.boxes.insert(uuid, GraphBox {creation_index, name: name.to_string(), uuid, fields});
        Ok(())
    }

    fn set_field(&mut self, address: &Address, value: FieldValue) -> Result<(), Error> {
        let graph_box = self.boxes.get_mut(&address.uuid).ok_or(Error::AddressNotFound)?;
        let (first, rest) = address.field_keys.split_first().ok_or(Error::AddressNotFound)?;
        let target = graph_box.fields
            .get_mut(first)
            .and_then(|value| resolve_path_mut(value, rest))
            .ok_or(Error::AddressNotFound)?;
        *target = value;
        Ok(())
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

fn resolve_path_mut<'a>(value: &'a mut FieldValue, keys: &[u16]) -> Option<&'a mut FieldValue> {
    if keys.is_empty() {
        return Some(value);
    }
    match value {
        FieldValue::Object(fields) => fields.get_mut(&keys[0]).and_then(|child| resolve_path_mut(child, &keys[1..])),
        FieldValue::Array(elements) => elements.get_mut(keys[0] as usize).and_then(|child| resolve_path_mut(child, &keys[1..])),
        _ => None
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
