//! The BoxGraph: a UUID→box map plus a resolved edge model. Mirrors lib-box `graph.ts` +
//! `graph-edges.ts`, but uses Rust-friendly ownership: boxes own their field values; pointers are
//! NOT object references but plain `Address` pairs in an edge list, with forward (source→target)
//! and incoming (target→sources) adjacency derived from them. Lookups go through the maps by key,
//! so nothing holds a borrow into another box. Loading is two-pass: insert all boxes, then resolve
//! edges (a pointer may target a box loaded earlier or later).

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;
use crate::address::{Address, Uuid};
use alloc::string::ToString;
use crate::boxes::{GraphBox, Registry};
use crate::bytes::{ByteReader, ByteWriter};
use crate::checksum::{checksum_fields, Checksum};
use crate::field::{read_fields, FieldValue};
use crate::subscription::{Deferred, DeferredOp, HubEvent, HubObserver, Propagation, SubscriptionId, Subscriptions, UpdateObserver};
use crate::updates::Update;
use crate::Error;

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub source: Address,         // address of the pointer field
    pub target: Option<Address>, // None = empty pointer
}

pub struct BoxGraph {
    boxes: BTreeMap<Uuid, GraphBox>,
    // Edges are maintained INCREMENTALLY (mirror lib-box `GraphEdges`): a transaction touches only the
    // edges of the boxes/pointers it changes, never a whole-graph rebuild (which on the audio thread made
    // selection churn — ephemeral SelectionBox new/delete — drop audio in busy projects). Both maps key by
    // Address (uuid, then field path), so all vertices of one box form a contiguous range.
    outgoing: BTreeMap<Address, Address>,       // pointer source → its (non-empty) target
    incoming: BTreeMap<Address, Vec<Address>>,  // target vertex → sources aiming at it, RESOLVED (target exists), sorted
    unresolved: BTreeMap<Address, Vec<Address>>,// target vertex → sources aiming at it while the target does NOT exist (dangling)
    affected: BTreeSet<Address>,                // targets whose incoming set changed THIS transaction (drives hub dispatch)
    next_index: i32,                            // creation index for boxes created via updates
    subscriptions: Subscriptions,               // change listeners notified during a transaction
}

impl BoxGraph {
    pub fn from_boxes(boxes: Vec<GraphBox>) -> Self {
        let mut map = BTreeMap::new();
        for graph_box in boxes {
            map.insert(graph_box.uuid, graph_box);
        }
        let next_index = map.values().map(|graph_box| graph_box.creation_index).max().map_or(0, |max| max + 1);
        let mut graph = Self {
            boxes: map, outgoing: BTreeMap::new(), incoming: BTreeMap::new(), unresolved: BTreeMap::new(),
            affected: BTreeSet::new(), next_index, subscriptions: Subscriptions::new()
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

    /// Every box with the given type name, in uuid order (e.g. all `NoteRegionBox`es).
    pub fn find_all_by_name(&self, name: &str) -> Vec<&GraphBox> {
        self.boxes.values().filter(|graph_box| graph_box.name == name).collect()
    }

    /// Every non-empty pointer edge (resolved or dangling). Rebuilt on demand from `outgoing`; used by
    /// tests / diagnostics only, so O(edges) is fine (the hot path reads the maps directly).
    pub fn edges(&self) -> Vec<Edge> {
        self.outgoing.iter().map(|(source, target)| Edge {source: source.clone(), target: Some(target.clone())}).collect()
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
        self.outgoing.get(source)
    }

    /// Sources of the pointer fields aiming at `target` (resolved edges only), in Address order.
    pub fn incoming(&self, target: &Address) -> Vec<&Address> {
        self.incoming.get(target).map(|sources| sources.iter().collect()).unwrap_or_default()
    }

    /// Edges whose non-empty target does not resolve to an existing vertex (dangling pointers).
    pub fn dangling(&self) -> Vec<Edge> {
        self.unresolved
            .iter()
            .flat_map(|(target, sources)| sources.iter().map(move |source|
                Edge {source: source.clone(), target: Some(target.clone())}))
            .collect()
    }

    /// The field value at an address (None for a box address or an unresolved path).
    pub fn field_value(&self, address: &Address) -> Option<&FieldValue> {
        let graph_box = self.boxes.get(&address.uuid)?;
        let (first, rest) = address.field_keys.split_first()?;
        graph_box.fields.get(first).and_then(|value| resolve_path(value, rest))
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

    /// Apply a transaction: every update forward with its incremental edge delta, then subscribers notified
    /// on the final, consistent graph (per-update observers, then pointer-hub membership diffs). Edges are
    /// maintained per-update (see `update_edges`) rather than rebuilt whole-graph, so the cost is O(changed),
    /// not O(all boxes) — the difference between a silent selection and an audible dropout.
    pub fn transaction(&mut self, updates: &[Update], registry: &Registry) -> Result<(), Error> {
        self.affected.clear();
        for update in updates {
            self.apply(update, registry)?;
            self.update_edges(update);
        }
        self.dispatch(updates);
        Ok(())
    }

    /// Notify subscribers after a transaction. The subscriptions are lifted out of `self` for the
    /// duration so each observer can be handed `&self` (the fully-resolved graph) to read — the
    /// standard "method needs &self plus one of its fields" move, not a second copy of state.
    fn dispatch(&mut self, updates: &[Update]) {
        if self.subscriptions.count() == 0 {
            return;
        }
        let mut subscriptions = core::mem::take(&mut self.subscriptions);
        for update in updates {
            subscriptions.dispatch(self, update);
        }
        // A hub's incoming set can only have changed if an edge to its target was (dis)connected this
        // transaction — every such target is in `affected`. So a pure primitive/automation transaction
        // (empty `affected`) skips the hub pass entirely, and a structural one recomputes ONLY the affected
        // hubs (the rest keep their unchanged `previous`). This is TS's affected-set model — the difference
        // between O(all hubs) and O(hubs actually touched) per transaction.
        if !self.affected.is_empty() {
            let targets = subscriptions.hub_targets();
            if !targets.is_empty() {
                let currents: Vec<Option<Vec<Address>>> = targets
                    .iter()
                    .map(|target| if self.affected.contains(target) {
                        Some(self.incoming(target).into_iter().cloned().collect())
                    } else {
                        None
                    })
                    .collect();
                subscriptions.dispatch_hubs(self, &currents);
            }
        }
        self.subscriptions = subscriptions;
        // Apply any (un)subscriptions observers queued reactively during dispatch (mirrors lib-box deferred
        // monitors): now that dispatch is done and `subscriptions` is back, we again hold `&mut`.
        self.apply_deferred();
    }

    /// A handle for binders to capture (at subscribe time) and use to add / drop targeted subscriptions
    /// REACTIVELY from inside an observer — applied after the transaction's dispatch. See `Deferred`.
    pub fn deferred(&self) -> Deferred {
        self.subscriptions.deferred()
    }

    /// Apply every queued `DeferredOp`. Vertex / unsubscribe ops touch only `subscriptions`; a hub op needs
    /// the graph's `incoming` to catch up its initial members, so application lives here (not in
    /// `Subscriptions`). Loops while ops remain, since a hub op's catch-up may queue further reactive subs.
    /// Called after every transaction's dispatch, and by a binder after an out-of-transaction `observe`.
    pub fn apply_deferred(&mut self) {
        while self.subscriptions.has_deferred() {
            for op in self.subscriptions.drain_deferred() {
                match op {
                    DeferredOp::Subscribe {id, propagation, address, observer} =>
                        self.subscriptions.register_vertex(id, propagation, address, observer),
                    DeferredOp::SubscribeHub {id, target, mut observer} => {
                        let current: Vec<Address> = self.incoming(&target).into_iter().cloned().collect();
                        for source in &current {
                            observer(self, &HubEvent::Added(source.clone()));
                        }
                        self.subscriptions.register_hub(id, target, current, observer);
                    }
                    DeferredOp::Unsubscribe {id} => {self.subscriptions.unsubscribe(id);}
                }
            }
        }
    }

    /// Subscribe to the pointers aiming at `target` (a hub), the analog of TS `PointerHub.subscribe`.
    /// Catches up by emitting `Added` for the current members, then emits Added/Removed as the
    /// incoming set changes each transaction. Used to track membership of pointer-built collections
    /// (value events, regions, device chains, notes, ...).
    pub fn subscribe_pointer_hub(&mut self, target: Address, mut observer: HubObserver) -> SubscriptionId {
        let current: Vec<Address> = self.incoming(&target).into_iter().cloned().collect();
        for source in &current {
            observer(self, &HubEvent::Added(source.clone()))
        }
        self.subscriptions.add_hub_monitor(target, current, observer)
    }

    /// Subscribe to every applied update. Returns a handle for `unsubscribe`.
    pub fn subscribe_all(&mut self, observer: UpdateObserver) -> SubscriptionId {
        self.subscriptions.subscribe_all(observer)
    }

    /// Subscribe to box creation / deletion only (the observer fires just for `New` / `Delete`). For
    /// watching "any box of a class" (e.g. `AudioFileBox`), where there is no address to target.
    pub fn subscribe_box_lifecycle(&mut self, observer: UpdateObserver) -> SubscriptionId {
        self.subscriptions.subscribe_lifecycle(observer)
    }

    /// Subscribe to updates at `address`, filtered by `propagation` (This / Parent / Children).
    pub fn subscribe_vertex(&mut self, propagation: Propagation, address: Address, observer: UpdateObserver) -> SubscriptionId {
        self.subscriptions.subscribe_vertex(propagation, address, observer)
    }

    /// Catch up to the current value at `address`, then subscribe to future primitive updates there;
    /// both invoke `observer` with the field value. Mirrors TS `catchupAndSubscribe` (primitive fields).
    pub fn catchup_and_subscribe<F>(&mut self, address: Address, mut observer: F) -> SubscriptionId
    where
        F: FnMut(&FieldValue) + 'static
    {
        if let Some(value) = self.field_value(&address) {
            observer(value);
        }
        self.subscribe_vertex(Propagation::This, address, Box::new(move |_graph, update| {
            if let Update::Primitive {new, ..} = update {
                observer(new)
            }
        }))
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

    /// Full rebuild of the edge maps from the boxes. Used on initial load (`from_boxes`) and after `abort`
    /// (a rollback replays inverse updates, so a one-shot rebuild is simplest there); the live forward path
    /// keeps them incrementally via `update_edges`.
    fn rebuild_edges(&mut self) {
        let mut edges = Vec::new();
        for graph_box in self.boxes.values() {
            for (key, value) in &graph_box.fields {
                collect_pointers(graph_box.uuid, value, &[*key], &mut edges);
            }
        }
        self.outgoing.clear();
        self.incoming.clear();
        self.unresolved.clear();
        for edge in edges {
            if let Some(target) = edge.target {
                self.edge_connect(edge.source, target);
            }
        }
    }

    /// Apply one update's edge delta to `outgoing` / `incoming` / `unresolved`. A `Primitive` update never
    /// touches an edge; `Pointer` re-points one edge; `New` / `Delete` add / drop a box's edges and
    /// re-resolve any danglers whose target just appeared / vanished.
    fn update_edges(&mut self, update: &Update) {
        match update {
            Update::New {uuid, ..} => self.on_box_created(*uuid),
            Update::Delete {uuid, ..} => self.on_box_deleted(*uuid),
            Update::Pointer {address, new, ..} => {
                self.edge_disconnect(address);
                if let Some(target) = new {
                    self.edge_connect(address.clone(), target.clone());
                }
            }
            // A primitive update is almost always a number/bool/string edit (no edge) — the hot automation
            // path — so it costs nothing here. But a pointer field re-point can also arrive as a `Primitive`
            // carrying a `Pointer` value (that's how the field mutation is expressed), so mirror the pointer arm.
            Update::Primitive {address, new: FieldValue::Pointer(new), ..} => {
                self.edge_disconnect(address);
                if let Some(target) = new {
                    self.edge_connect(address.clone(), target.clone());
                }
            }
            Update::Primitive {..} => {}
        }
    }

    /// Record a pointer edge, filing it under `incoming` if its target already exists, else `unresolved`.
    fn edge_connect(&mut self, source: Address, target: Address) {
        let exists = self.vertex_exists(&target);
        self.affected.insert(target.clone());
        self.outgoing.insert(source.clone(), target.clone());
        let bucket = if exists {&mut self.incoming} else {&mut self.unresolved};
        insert_source(bucket.entry(target).or_default(), source);
    }

    /// Drop the pointer edge at `source` from `outgoing` and from whichever bucket held it.
    fn edge_disconnect(&mut self, source: &Address) {
        if let Some(target) = self.outgoing.remove(source) {
            self.affected.insert(target.clone());
            remove_source_from(&mut self.incoming, &target, source);
            remove_source_from(&mut self.unresolved, &target, source);
        }
    }

    /// A box appeared: wire its own outgoing pointers, then re-resolve any dangling edges that were waiting
    /// for a vertex inside this box (its subtree is the contiguous `uuid` range in `unresolved`).
    fn on_box_created(&mut self, uuid: Uuid) {
        let mut edges = Vec::new();
        if let Some(graph_box) = self.boxes.get(&uuid) {
            for (key, value) in &graph_box.fields {
                collect_pointers(uuid, value, &[*key], &mut edges);
            }
        }
        for edge in edges {
            if let Some(target) = edge.target {
                self.edge_connect(edge.source, target);
            }
        }
        let waiting: Vec<Address> = self.unresolved
            .range(Address::box_of(uuid)..)
            .take_while(|(target, _)| target.uuid == uuid)
            .map(|(target, _)| target.clone())
            .collect();
        for target in waiting {
            if self.vertex_exists(&target) {
                if let Some(sources) = self.unresolved.remove(&target) {
                    self.affected.insert(target.clone());
                    let bucket = self.incoming.entry(target).or_default();
                    for source in sources {
                        insert_source(bucket, source);
                    }
                }
            }
        }
    }

    /// A box vanished: disconnect its own outgoing pointers, then demote every edge that targeted a vertex
    /// inside it (its `uuid` range in `incoming`) to `unresolved` — those sources are now dangling.
    fn on_box_deleted(&mut self, uuid: Uuid) {
        let sources: Vec<Address> = self.outgoing
            .range(Address::box_of(uuid)..)
            .take_while(|(source, _)| source.uuid == uuid)
            .map(|(source, _)| source.clone())
            .collect();
        for source in sources {
            self.edge_disconnect(&source);
        }
        let targets: Vec<Address> = self.incoming
            .range(Address::box_of(uuid)..)
            .take_while(|(target, _)| target.uuid == uuid)
            .map(|(target, _)| target.clone())
            .collect();
        for target in targets {
            if let Some(sources) = self.incoming.remove(&target) {
                self.affected.insert(target.clone());
                let bucket = self.unresolved.entry(target).or_default();
                for source in sources {
                    insert_source(bucket, source);
                }
            }
        }
    }
}

/// Insert `source` into a bucket kept sorted by Address (so `incoming` order matches a full rebuild's
/// box-then-field iteration order). A duplicate is ignored.
fn insert_source(bucket: &mut Vec<Address>, source: Address) {
    if let Err(position) = bucket.binary_search(&source) {
        bucket.insert(position, source);
    }
}

/// Remove `source` from `map[target]` (a sorted bucket), dropping the entry when it empties.
fn remove_source_from(map: &mut BTreeMap<Address, Vec<Address>>, target: &Address, source: &Address) {
    if let Some(bucket) = map.get_mut(target) {
        if let Ok(position) = bucket.binary_search(source) {
            bucket.remove(position);
        }
        if bucket.is_empty() {
            map.remove(target);
        }
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
