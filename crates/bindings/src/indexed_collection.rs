//! `IndexedCollection`: the Rust counterpart of TS `IndexedBoxAdapterCollection`. A device chain (an audio
//! unit's `midi-effects` / `audio-effects` host) is an ordered set of device boxes: each device points its
//! `host` at the unit's host field and carries an `int32` `index` that defines its place in the chain. This
//! binder catches up + subscribes the host's pointer hub (membership) and re-reads a member's `index` when
//! it is edited, exposing the member uuids sorted by `index`. The consumer (the engine) maps each uuid to a
//! device bridge and wires the chain in that order, re-wiring whenever `sorted()` changes.
//!
//! Subscriptions are fully TARGETED (no all-updates listener): the hub monitor handles membership, and each
//! member gets a `This` monitor on its own `index` field for reorders. Since an observer holds only
//! `&BoxGraph` and cannot subscribe mid-callback, the per-member monitors are queued on the graph's deferred
//! handle (from the hub observer) and registered after the transaction's dispatch (mirrors lib-box's
//! per-member `indexField.subscribe` inside `onAdded`).

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::RefCell;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, Propagation, SubscriptionId};

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
    dirty: bool,
    on_dirty: Option<Rc<dyn Fn()>>,    // fired when the order changes, so the owning unit can enqueue itself
    index_subs: BTreeMap<Uuid, SubscriptionId> // per-member TARGETED monitor on its `index` field (reorder)
}

struct Entry {
    uuid: Uuid,
    index: i32
}

impl State {
    fn new(index_key: u16) -> Self {
        Self {index_key, entries: Vec::new(), dirty: false, on_dirty: None, index_subs: BTreeMap::new()}
    }

    /// Raise the dirty flag and notify the optional observer (TS `invalidateWiring`'s notify): the consumer
    /// re-wires only this chain's scope, and the observer lets the owning unit enqueue itself for reconcile.
    fn raise(&mut self) {
        self.dirty = true;
        if let Some(signal) = &self.on_dirty {
            signal();
        }
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
        self.raise();
    }

    fn remove(&mut self, uuid: Uuid) {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.uuid != uuid);
        if self.entries.len() != before {
            self.raise();
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
                self.raise();
            }
        }
    }

    // Stable sort by index, so equal indices keep insertion order (deterministic, matching TS's stable sort).
    fn sort(&mut self) {
        self.entries.sort_by_key(|entry| entry.index);
    }
}

impl IndexedCollection {
    /// Observe the device boxes whose `host` points at `host` (a unit's host field, e.g. `midi-effects`),
    /// reading each device's `index` from field `index_key`. Membership is the pointer-hub; a member's
    /// reorder is a TARGETED `This` monitor on that member's `index` field, added when it joins (deferred)
    /// and dropped when it leaves — no all-updates listener. `index_key` 0 means the host is unordered (the
    /// single-instrument `input`), so no reorder monitor is needed.
    pub fn observe(graph: &mut BoxGraph, host: Address, index_key: u16) -> Self {
        let state = Rc::new(RefCell::new(State::new(index_key)));
        let mut subscriptions = Vec::new();
        let hub_state = state.clone();
        let deferred = graph.deferred();
        subscriptions.push(graph.subscribe_pointer_hub(host, Box::new(move |graph, event| match event {
            HubEvent::Added(source) => {
                let member = source.uuid;
                hub_state.borrow_mut().add(graph, member);
                if index_key != 0 {
                    let edit_state = hub_state.clone();
                    let id = deferred.subscribe_vertex(Propagation::This, Address::of(member, alloc::vec![index_key]),
                        Box::new(move |graph, _update| edit_state.borrow_mut().refresh(graph, member)));
                    hub_state.borrow_mut().index_subs.insert(member, id);
                }
            }
            HubEvent::Removed(source) => {
                hub_state.borrow_mut().remove(source.uuid);
                if let Some(id) = hub_state.borrow_mut().index_subs.remove(&source.uuid) {
                    deferred.unsubscribe(id);
                }
            }
        })));
        // Register the reorder monitors the catch-up queued for existing members (we hold `&mut graph`).
        graph.apply_deferred();
        Self {state, subscriptions}
    }

    /// Wire a callback fired whenever this chain's order changes (an `invalidateWiring`-style notify). The
    /// owning unit passes a closure that enqueues itself, so a chain edit reconciles ONE unit instead of a
    /// sweep. Set AFTER the catch-up so the initial members do not fire it (the unit enqueues itself once).
    pub fn set_on_dirty(&self, signal: Rc<dyn Fn()>) {
        self.state.borrow_mut().on_dirty = Some(signal);
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

    /// Unsubscribe the hub observer and every per-member reorder monitor (mirrors the TS adapter's `terminate`).
    pub fn terminate(self, graph: &mut BoxGraph) {
        for id in self.subscriptions {
            graph.unsubscribe(id);
        }
        for (_, id) in core::mem::take(&mut self.state.borrow_mut().index_subs) {
            graph.unsubscribe(id);
        }
    }
}
