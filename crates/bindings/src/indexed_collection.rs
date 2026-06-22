//! `IndexedCollection`: the Rust counterpart of TS `IndexedBoxAdapterCollection`. A device chain (an audio
//! unit's `midi-effects` / `audio-effects` host) is an ordered set of device boxes: each device points its
//! `host` at the unit's host field and carries an `int32` `index` that defines its place in the chain. This
//! binder catches up + subscribes the host's pointer hub (membership) and re-reads a member's `index` when
//! it is edited, exposing the member uuids sorted by `index`. The consumer (the engine) maps each uuid to a
//! device bridge and wires the chain in that order, re-wiring whenever `sorted()` changes.
//!
//! Like the other binders, observers receive `&BoxGraph` only, so this never subscribes per-member from
//! inside an observer: one `subscribe_all` re-reads the affected member's `index` (mirrors `NoteCollection`'s
//! edit path), and the hub monitor handles add / remove.

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::RefCell;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, SubscriptionId};
use boxgraph::updates::Update;

pub struct IndexedCollection {
    state: Rc<RefCell<State>>,
    subscriptions: Vec<SubscriptionId>
}

/// The members and the field key their `index` lives at. `entries` is kept in `index` order, so reads are
/// O(1) and the rare membership / index edit re-sorts. `dirty` is raised ONLY when the order actually
/// changes (a member connects / disconnects, or a member's `index` changes value) — never on unrelated
/// edits — so a consumer re-wires only when this chain's scope changed (mirrors TS `invalidateWiring`).
struct State {
    index_key: u16,
    entries: Vec<Entry>,
    dirty: bool
}

struct Entry {
    uuid: Uuid,
    index: i32
}

impl State {
    fn new(index_key: u16) -> Self {
        Self {index_key, entries: Vec::new(), dirty: false}
    }

    fn read_index(&self, graph: &BoxGraph, uuid: Uuid) -> i32 {
        graph.field_value(&Address::of(uuid, alloc::vec![self.index_key]))
            .and_then(|value| value.as_int32())
            .unwrap_or(0)
    }

    fn add(&mut self, graph: &BoxGraph, uuid: Uuid) {
        if self.entries.iter().any(|entry| entry.uuid == uuid) {
            return;
        }
        let index = self.read_index(graph, uuid);
        self.entries.push(Entry {uuid, index});
        self.sort();
        self.dirty = true;
    }

    fn remove(&mut self, uuid: Uuid) {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.uuid != uuid);
        if self.entries.len() != before {
            self.dirty = true;
        }
    }

    /// Re-read a member's `index` after an edit; re-sort and mark dirty ONLY if the value changed. No-op
    /// for a non-member update or an edit that left the index unchanged.
    fn refresh(&mut self, graph: &BoxGraph, uuid: Uuid) {
        let index = self.read_index(graph, uuid);
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.uuid == uuid) {
            if entry.index != index {
                entry.index = index;
                self.sort();
                self.dirty = true;
            }
        }
    }

    fn is_member(&self, uuid: Uuid) -> bool {
        self.entries.iter().any(|entry| entry.uuid == uuid)
    }

    // Stable sort by index, so equal indices keep insertion order (deterministic, matching TS's stable sort).
    fn sort(&mut self) {
        self.entries.sort_by_key(|entry| entry.index);
    }
}

impl IndexedCollection {
    /// Observe the device boxes whose `host` points at `host` (a unit's host field, e.g. `midi-effects`),
    /// reading each device's `index` from field `index_key`. Catches up to the current members, then keeps
    /// the order live as members connect / disconnect and as any member's `index` is edited.
    pub fn observe(graph: &mut BoxGraph, host: Address, index_key: u16) -> Self {
        let state = Rc::new(RefCell::new(State::new(index_key)));
        let mut subscriptions = Vec::new();
        let hub_state = state.clone();
        subscriptions.push(graph.subscribe_pointer_hub(host, Box::new(move |graph, event| match event {
            HubEvent::Added(source) => hub_state.borrow_mut().add(graph, source.uuid),
            HubEvent::Removed(source) => hub_state.borrow_mut().remove(source.uuid)
        })));
        let edit_state = state.clone();
        subscriptions.push(graph.subscribe_all(Box::new(move |graph, update| {
            let uuid = update_uuid(update);
            if edit_state.borrow().is_member(uuid) {
                edit_state.borrow_mut().refresh(graph, uuid);
            }
        })));
        Self {state, subscriptions}
    }

    /// The member uuids, ordered by `index`.
    pub fn sorted(&self) -> Vec<Uuid> {
        self.state.borrow().entries.iter().map(|entry| entry.uuid).collect()
    }

    pub fn len(&self) -> usize {
        self.state.borrow().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.state.borrow().entries.is_empty()
    }

    /// The member indices in order (parallel to `sorted`).
    pub fn sorted_indices(&self) -> Vec<i32> {
        self.state.borrow().entries.iter().map(|entry| entry.index).collect()
    }

    /// Consume the dirty flag: returns whether this chain's order changed since the last call (and clears
    /// it). The consumer re-wires its scope iff this is `true`, so an unchanged chain is never re-wired.
    pub fn take_dirty(&self) -> bool {
        let mut state = self.state.borrow_mut();
        let dirty = state.dirty;
        state.dirty = false;
        dirty
    }

    /// Unsubscribe from `graph` (mirrors the TS adapter's `terminate`).
    pub fn terminate(self, graph: &mut BoxGraph) {
        for id in self.subscriptions {
            graph.unsubscribe(id);
        }
    }
}

fn update_uuid(update: &Update) -> Uuid {
    match update {
        Update::Primitive {address, ..} | Update::Pointer {address, ..} => address.uuid,
        Update::New {uuid, ..} | Update::Delete {uuid, ..} => *uuid
    }
}
