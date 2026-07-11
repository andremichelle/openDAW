//! Change subscriptions, mirroring lib-box graph listeners + dispatchers. Two kinds:
//!   - all-updates listeners: notified of every applied update (like `subscribeToAllUpdates`).
//!   - vertex monitors targeted at an `Address` with `Propagation`:
//!     This = fires when the update is exactly at the address;
//!     Parent = fires when the update is at or under the address (the monitor is an ancestor);
//!     Children = fires when the update is at or above the address (the monitor is a descendant).
//!
//! Observers receive `&BoxGraph` plus the change (`&Update` / `&HubEvent`). The graph dispatches
//! after the whole transaction is applied and edges are rebuilt, so the graph handed to an observer
//! is fully consistent: it may freely read it (resolve `incoming`, `field_value`, ...) to materialize
//! its view. It cannot re-subscribe (the reference is shared), which is the invariant we want. Each
//! subscribe returns a `SubscriptionId`; `unsubscribe` drops the observer, freeing whatever it
//! captured. Vertex monitors and all-listeners fire in subscription order (vertex monitors first),
//! then pointer-hub diffs.

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use crate::address::Address;
use crate::graph::BoxGraph;
use crate::updates::Update;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Propagation {This, Parent, Children}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct SubscriptionId(u64);

pub type UpdateObserver = Box<dyn FnMut(&BoxGraph, &Update)>;

/// A change to the set of pointers aiming at a hub target (the Rust analog of TS PointerHub events).
/// `Added`/`Removed` carry the source pointer address that connected / disconnected.
#[derive(Clone, Debug, PartialEq)]
pub enum HubEvent {
    Added(Address),
    Removed(Address)
}

pub type HubObserver = Box<dyn FnMut(&BoxGraph, &HubEvent)>;

#[derive(Clone, Copy)]
enum Bucket {This, Parent, Children}

struct Monitor {
    id: SubscriptionId,
    address: Address,
    observer: UpdateObserver
}

// Watches the incoming pointers at `target`; `previous` is the last-known set, diffed after each
// transaction to emit Added/Removed.
struct HubMonitor {
    id: SubscriptionId,
    target: Address,
    previous: Vec<Address>,
    observer: HubObserver
}

/// Vertex monitors are bucketed by propagation, each bucket kept SORTED by address (then insertion id),
/// so dispatch resolves matches sub-linearly (binary search), mirroring lib-box `Dispatcher`. The derived
/// `Address` ordering (uuid, then field keys) places every descendant of an address in one contiguous run
/// right after it, so a subtree (Children) is a range and an exact hit (This) is a binary-searchable run.
/// A subscription request an observer queued mid-dispatch (it holds only `&BoxGraph`, so it cannot
/// subscribe directly). The graph applies these AFTER the transaction's dispatch, when it holds `&mut`.
/// Mirrors lib-box `DeferredMonitor`. The id is reserved at enqueue time so the caller can store it and
/// later `unsubscribe`, whether or not it has been applied yet.
pub enum DeferredOp {
    Subscribe {id: SubscriptionId, propagation: Propagation, address: Address, observer: UpdateObserver},
    SubscribeHub {id: SubscriptionId, target: Address, observer: HubObserver},
    Unsubscribe {id: SubscriptionId}
}

/// A cloneable handle an observer captures (at subscribe time, with `&mut graph`) to add / drop targeted
/// subscriptions REACTIVELY from inside its callback — the Rust-shaped equivalent of TS subscribing inside
/// an `onAdded`. Calls enqueue `DeferredOp`s applied after dispatch; ids are issued from the same counter
/// as direct subscriptions, so they never collide.
#[derive(Clone)]
pub struct Deferred {
    next_id: Rc<Cell<u64>>,
    ops: Rc<RefCell<Vec<DeferredOp>>>
}

impl Deferred {
    pub fn subscribe_vertex(&self, propagation: Propagation, address: Address, observer: UpdateObserver) -> SubscriptionId {
        let id = self.reserve();
        self.ops.borrow_mut().push(DeferredOp::Subscribe {id, propagation, address, observer});
        id
    }

    pub fn subscribe_pointer_hub(&self, target: Address, observer: HubObserver) -> SubscriptionId {
        let id = self.reserve();
        self.ops.borrow_mut().push(DeferredOp::SubscribeHub {id, target, observer});
        id
    }

    pub fn unsubscribe(&self, id: SubscriptionId) {
        self.ops.borrow_mut().push(DeferredOp::Unsubscribe {id});
    }

    fn reserve(&self) -> SubscriptionId {
        let id = SubscriptionId(self.next_id.get());
        self.next_id.set(id.0 + 1);
        id
    }
}

pub struct Subscriptions {
    all: Vec<(SubscriptionId, UpdateObserver)>,
    lifecycle: Vec<(SubscriptionId, UpdateObserver)>, // fire ONLY on box New / Delete (a box-class watcher)
    this: Vec<Monitor>,     // fire when update address == monitor address
    parent: Vec<Monitor>,   // fire when update is at/under monitor (monitor is a prefix of the update)
    children: Vec<Monitor>, // fire when update is at/over monitor (update is a prefix of the monitor)
    hubs: Vec<HubMonitor>,
    next_id: Rc<Cell<u64>>,
    deferred: Rc<RefCell<Vec<DeferredOp>>>
}

impl Subscriptions {
    pub fn new() -> Self {
        Self {
            all: Vec::new(), lifecycle: Vec::new(), this: Vec::new(), parent: Vec::new(), children: Vec::new(),
            hubs: Vec::new(), next_id: Rc::new(Cell::new(0)), deferred: Rc::new(RefCell::new(Vec::new()))
        }
    }

    /// Subscribe to box creation / deletion only. The dispatcher invokes the observer just for `New` /
    /// `Delete` updates (infrequent), so a watcher for "any box of class X" costs nothing on field edits.
    /// This is the one non-address-targeted listener (a not-yet-created box has no address to target).
    pub fn subscribe_lifecycle(&mut self, observer: UpdateObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.lifecycle.push((id, observer));
        id
    }

    /// A handle observers capture to queue reactive (un)subscriptions, applied by `apply_deferred` after
    /// dispatch. Shares this `Subscriptions`' id counter + deferred queue.
    pub fn deferred(&self) -> Deferred {
        Deferred {next_id: self.next_id.clone(), ops: self.deferred.clone()}
    }

    /// Take all queued `DeferredOp`s for the graph to apply (it owns the `incoming` data a hub op's catch-up
    /// needs). Applying one may queue more (a nested reactive subscribe), so the graph loops while `has_deferred`.
    pub fn drain_deferred(&mut self) -> Vec<DeferredOp> {
        core::mem::take(&mut *self.deferred.borrow_mut())
    }

    pub fn has_deferred(&self) -> bool {
        !self.deferred.borrow().is_empty()
    }

    /// Register a vertex monitor with an already-reserved id (the deferred-apply path; see `subscribe_vertex`).
    pub(crate) fn register_vertex(&mut self, id: SubscriptionId, propagation: Propagation, address: Address, observer: UpdateObserver) {
        self.insert_vertex(id, propagation, address, observer);
    }

    /// Register a pointer-hub monitor with an already-reserved id + its caught-up member set (the graph
    /// computes the set, as in `subscribe_pointer_hub`).
    pub(crate) fn register_hub(&mut self, id: SubscriptionId, target: Address, previous: Vec<Address>, observer: HubObserver) {
        self.hubs.push(HubMonitor {id, target, previous, observer});
    }

    pub fn count(&self) -> usize {
        self.all.len() + self.lifecycle.len() + self.this.len() + self.parent.len() + self.children.len() + self.hubs.len()
    }

    pub fn subscribe_all(&mut self, observer: UpdateObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.all.push((id, observer));
        id
    }

    pub fn subscribe_vertex(&mut self, propagation: Propagation, address: Address, observer: UpdateObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.insert_vertex(id, propagation, address, observer);
        id
    }

    /// Insert a vertex monitor with an already-reserved id (shared by `subscribe_vertex` and the deferred
    /// apply), keeping the bucket sorted by address; ids are monotonic, so an equal-address run stays
    /// ordered by id (which dispatch restores as fire order).
    fn insert_vertex(&mut self, id: SubscriptionId, propagation: Propagation, address: Address, observer: UpdateObserver) {
        let monitor = Monitor {id, address, observer};
        let bucket = match propagation {
            Propagation::This => &mut self.this,
            Propagation::Parent => &mut self.parent,
            Propagation::Children => &mut self.children
        };
        let at = bucket.partition_point(|other| other.address <= monitor.address);
        bucket.insert(at, monitor);
    }

    /// Register a pointer-hub monitor with its initial member set (the graph computes both, since it
    /// owns the edge model). Returns the handle.
    pub fn add_hub_monitor(&mut self, target: Address, previous: Vec<Address>, observer: HubObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.hubs.push(HubMonitor {id, target, previous, observer});
        id
    }

    /// The targets currently watched, in monitor order (so `dispatch_hubs` can be fed matching sets).
    pub fn hub_targets(&self) -> Vec<Address> {
        self.hubs.iter().map(|hub| hub.target.clone()).collect()
    }

    /// Diff each AFFECTED hub's `current` incoming set against its previous, emitting Added/Removed, then
    /// store. `currents[i]` is `None` for a hub the transaction did not touch (its incoming set is unchanged,
    /// so it is skipped and its `previous` kept) — the caller only computes `Some` for hubs whose target is
    /// in the transaction's affected set, so an unaffected hub costs nothing here.
    pub fn dispatch_hubs(&mut self, graph: &BoxGraph, currents: &[Option<Vec<Address>>]) {
        for (hub, current) in self.hubs.iter_mut().zip(currents) {
            let Some(current) = current else {continue};
            for source in current {
                if !hub.previous.contains(source) {
                    (hub.observer)(graph, &HubEvent::Added(source.clone()))
                }
            }
            for source in &hub.previous {
                if !current.contains(source) {
                    (hub.observer)(graph, &HubEvent::Removed(source.clone()))
                }
            }
            hub.previous = current.clone();
        }
    }

    /// Remove a subscription, dropping its observer (frees captured state). Returns whether one was removed.
    /// `retain` preserves each bucket's sort order.
    pub fn unsubscribe(&mut self, id: SubscriptionId) -> bool {
        let before = self.count();
        self.all.retain(|(other, _)| *other != id);
        self.lifecycle.retain(|(other, _)| *other != id);
        self.this.retain(|monitor| monitor.id != id);
        self.parent.retain(|monitor| monitor.id != id);
        self.children.retain(|monitor| monitor.id != id);
        self.hubs.retain(|hub| hub.id != id);
        // Also cancel a queued-but-not-yet-applied deferred subscribe with this id (subscribed and dropped
        // within the same transaction, e.g. a member that joined and left before dispatch finished).
        self.deferred.borrow_mut().retain(|op| !matches!(op, DeferredOp::Subscribe {id: other, ..} if *other == id));
        before != self.count()
    }

    pub fn dispatch(&mut self, graph: &BoxGraph, update: &Update) {
        let address = update_address(update);
        // Gather matching monitor ids from each bucket via a sub-linear search, fire them in subscription
        // order (mirroring lib-box, which sorts matches by `order`), then the all-listeners.
        let mut hits: Vec<(SubscriptionId, Bucket, usize)> = Vec::new();
        Self::collect_this(&self.this, &address, &mut hits);
        Self::collect_parent(&self.parent, &address, &mut hits);
        Self::collect_children(&self.children, &address, &mut hits);
        hits.sort_unstable_by_key(|(id, _, _)| *id);
        for (_, bucket, index) in hits {
            let monitor = match bucket {
                Bucket::This => &mut self.this[index],
                Bucket::Parent => &mut self.parent[index],
                Bucket::Children => &mut self.children[index]
            };
            (monitor.observer)(graph, update)
        }
        for (_, observer) in &mut self.all {
            observer(graph, update)
        }
        if matches!(update, Update::New {..} | Update::Delete {..}) {
            for (_, observer) in &mut self.lifecycle {
                observer(graph, update)
            }
        }
    }

    /// Exact hits: the contiguous run of monitors whose address equals `target` (binary-searched).
    fn collect_this(bucket: &[Monitor], target: &Address, out: &mut Vec<(SubscriptionId, Bucket, usize)>) {
        let mut index = bucket.partition_point(|monitor| monitor.address < *target);
        while index < bucket.len() && bucket[index].address == *target {
            out.push((bucket[index].id, Bucket::This, index));
            index += 1;
        }
    }

    /// Ancestor hits: monitors whose address is a PREFIX of `target` (the box itself and each leading
    /// key-path slice). There are `field_keys.len() + 1` such prefixes; probe each with a binary search.
    fn collect_parent(bucket: &[Monitor], target: &Address, out: &mut Vec<(SubscriptionId, Bucket, usize)>) {
        for prefix_len in 0..=target.field_keys.len() {
            let prefix = Address::of(target.uuid, target.field_keys[..prefix_len].to_vec());
            let mut index = bucket.partition_point(|monitor| monitor.address < prefix);
            while index < bucket.len() && bucket[index].address == prefix {
                out.push((bucket[index].id, Bucket::Parent, index));
                index += 1;
            }
        }
    }

    /// Descendant hits: monitors in `target`'s subtree (those whose address `starts_with` target). Sorted
    /// order makes the subtree one contiguous run beginning at the lower bound of `target`.
    fn collect_children(bucket: &[Monitor], target: &Address, out: &mut Vec<(SubscriptionId, Bucket, usize)>) {
        let mut index = bucket.partition_point(|monitor| monitor.address < *target);
        while index < bucket.len() && bucket[index].address.starts_with(target) {
            out.push((bucket[index].id, Bucket::Children, index));
            index += 1;
        }
    }

    fn fresh_id(&mut self) -> SubscriptionId {
        let value = self.next_id.get();
        self.next_id.set(value + 1);
        SubscriptionId(value)
    }
}

impl Default for Subscriptions {
    fn default() -> Self {
        Self::new()
    }
}

/// The address an update targets: the field address for primitive/pointer, the box address for new/delete.
fn update_address(update: &Update) -> Address {
    match update {
        Update::New {uuid, ..} | Update::Delete {uuid, ..} => Address::box_of(*uuid),
        Update::Primitive {address, ..} | Update::Pointer {address, ..} => address.clone()
    }
}
