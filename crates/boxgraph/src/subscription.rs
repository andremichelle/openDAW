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
use alloc::vec::Vec;
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

struct Monitor {
    id: SubscriptionId,
    address: Address,
    propagation: Propagation,
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

pub struct Subscriptions {
    all: Vec<(SubscriptionId, UpdateObserver)>,
    monitors: Vec<Monitor>,
    hubs: Vec<HubMonitor>,
    next_id: u64
}

impl Subscriptions {
    pub fn new() -> Self {
        Self {all: Vec::new(), monitors: Vec::new(), hubs: Vec::new(), next_id: 0}
    }

    pub fn count(&self) -> usize {
        self.all.len() + self.monitors.len() + self.hubs.len()
    }

    pub fn subscribe_all(&mut self, observer: UpdateObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.all.push((id, observer));
        id
    }

    pub fn subscribe_vertex(&mut self, propagation: Propagation, address: Address, observer: UpdateObserver) -> SubscriptionId {
        let id = self.fresh_id();
        self.monitors.push(Monitor {id, address, propagation, observer});
        id
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

    /// Diff each hub's `current` incoming set against its previous, emitting Added/Removed, then store.
    pub fn dispatch_hubs(&mut self, graph: &BoxGraph, currents: &[Vec<Address>]) {
        for (hub, current) in self.hubs.iter_mut().zip(currents) {
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
    pub fn unsubscribe(&mut self, id: SubscriptionId) -> bool {
        let before = self.count();
        self.all.retain(|(other, _)| *other != id);
        self.monitors.retain(|monitor| monitor.id != id);
        self.hubs.retain(|hub| hub.id != id);
        before != self.count()
    }

    pub fn dispatch(&mut self, graph: &BoxGraph, update: &Update) {
        let address = update_address(update);
        for monitor in &mut self.monitors {
            let fires = match monitor.propagation {
                Propagation::This => address == monitor.address,
                Propagation::Parent => address.starts_with(&monitor.address),
                Propagation::Children => monitor.address.starts_with(&address)
            };
            if fires {
                (monitor.observer)(graph, update)
            }
        }
        for (_, observer) in &mut self.all {
            observer(graph, update)
        }
    }

    fn fresh_id(&mut self) -> SubscriptionId {
        let id = SubscriptionId(self.next_id);
        self.next_id += 1;
        id
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
