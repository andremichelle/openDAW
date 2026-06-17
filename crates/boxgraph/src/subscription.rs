//! Change subscriptions, mirroring lib-box graph listeners + dispatchers. Two kinds:
//!   - all-updates listeners: notified of every applied update (like `subscribeToAllUpdates`).
//!   - vertex monitors targeted at an `Address` with `Propagation`:
//!       This     fires when the update is exactly at the address
//!       Parent   fires when the update is at or under the address (the monitor is an ancestor)
//!       Children fires when the update is at or above the address (the monitor is a descendant)
//!
//! Observers receive the `&Update`. The graph dispatches each update during `transaction`, right
//! after it is applied to the box values (edges are rebuilt once at the end of the transaction).
//! Each subscribe returns a `SubscriptionId`; `unsubscribe` drops the observer, freeing whatever it
//! captured. Vertex monitors and all-listeners fire in subscription order (vertex monitors first).

use alloc::boxed::Box;
use alloc::vec::Vec;
use crate::address::Address;
use crate::updates::Update;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Propagation {This, Parent, Children}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct SubscriptionId(u64);

pub type UpdateObserver = Box<dyn FnMut(&Update)>;

struct Monitor {
    id: SubscriptionId,
    address: Address,
    propagation: Propagation,
    observer: UpdateObserver
}

pub struct Subscriptions {
    all: Vec<(SubscriptionId, UpdateObserver)>,
    monitors: Vec<Monitor>,
    next_id: u64
}

impl Subscriptions {
    pub fn new() -> Self {
        Self {all: Vec::new(), monitors: Vec::new(), next_id: 0}
    }

    pub fn count(&self) -> usize {
        self.all.len() + self.monitors.len()
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

    /// Remove a subscription, dropping its observer (frees captured state). Returns whether one was removed.
    pub fn unsubscribe(&mut self, id: SubscriptionId) -> bool {
        let before = self.count();
        self.all.retain(|(other, _)| *other != id);
        self.monitors.retain(|monitor| monitor.id != id);
        before != self.count()
    }

    pub fn dispatch(&mut self, update: &Update) {
        let address = update_address(update);
        for monitor in &mut self.monitors {
            let fires = match monitor.propagation {
                Propagation::This => address == monitor.address,
                Propagation::Parent => address.starts_with(&monitor.address),
                Propagation::Children => monitor.address.starts_with(&address)
            };
            if fires {
                (monitor.observer)(update)
            }
        }
        for (_, observer) in &mut self.all {
            observer(update)
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
