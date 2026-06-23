//! Observe a `ValueEventCollectionBox`: keep an owned `EventCollection<ValueEvent>` in sync, built
//! incrementally from membership and edit events (the Rust counterpart of TS
//! `ValueEventCollectionBoxAdapter`). There is NO periodic rebuild: each subscription observer is
//! handed the consistent graph when it fires and mutates the cached collection directly.
//!
//!   - membership: a pointer-hub subscription on the collection's events hub. Its catch-up emits
//!     `Added` for every existing member (so `observe` needs no separate initial build), then
//!     `Added`/`Removed` as events connect / disconnect. `Added` reads that one event box and inserts
//!     it; `Removed` drops it.
//!   - edits: an all-updates observer. When an update touches a member event (or a curve box shaping
//!     one), that single event is re-read and replaced.
//!
//! Two structures, mirroring the TS adapter's `#events` + `#adapters`: `events` is the position-sorted
//! `EventCollection` the engine evaluates, and `index` maps each member's uuid to its current
//! `ValueEvent` (the TS keeps the same uuid→event map so it can remove / replace by uuid, since the
//! sorted collection is keyed by position, not uuid).

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Ref, RefCell};
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, SubscriptionId};
use boxgraph::updates::Update;
use value::event::EventCollection;
use value::value::{value_at, ValueEvent};
use crate::value_events::{event_of_curve, read_value_event, COLLECTION_EVENTS};

pub struct ValueCollection {
    state: Rc<RefCell<State>>,
    subscriptions: Vec<SubscriptionId>
}

/// The shared cache the observers maintain.
struct State {
    events: EventCollection<ValueEvent>,
    index: BTreeMap<Uuid, ValueEvent> // event uuid -> its current ValueEvent (for remove / replace by uuid)
}

impl State {
    fn new() -> Self {
        Self {events: EventCollection::new(), index: BTreeMap::new()}
    }

    /// Read `event_uuid` from the graph and (re)place it in both structures.
    fn upsert(&mut self, graph: &BoxGraph, event_uuid: Uuid) {
        let value_event = read_value_event(graph, event_uuid);
        if let Some(previous) = self.index.insert(event_uuid, value_event) {
            self.events.remove(&previous);
        }
        self.events.add(value_event);
    }

    fn remove(&mut self, event_uuid: Uuid) {
        if let Some(previous) = self.index.remove(&event_uuid) {
            self.events.remove(&previous);
        }
    }

    /// The member event an update affects, if any: the member event itself, the member event a curve's
    /// pointer now / previously targets (attach / detach), or the event a curve box shapes (slope edit).
    fn affected(&self, graph: &BoxGraph, update: &Update) -> Option<Uuid> {
        let uuid = affected_uuid(update);
        if self.index.contains_key(&uuid) {
            return Some(uuid);
        }
        if let Update::Pointer {new, old, ..} = update {
            for target in [new, old].into_iter().flatten() {
                if self.index.contains_key(&target.uuid) {
                    return Some(target.uuid);
                }
            }
        }
        event_of_curve(graph, uuid).filter(|event_uuid| self.index.contains_key(event_uuid))
    }
}

impl ValueCollection {
    /// Subscribe to the collection and build it from the pointer-hub catch-up (`Added` per existing
    /// member) plus all-updates edits. The observers hold the shared state and receive the graph each
    /// time they fire, so the cache stays current with no rebuild step.
    pub fn observe(graph: &mut BoxGraph, collection: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();

        let hub_state = state.clone();
        subscriptions.push(graph.subscribe_pointer_hub(
            Address::of(collection, vec![COLLECTION_EVENTS]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => hub_state.borrow_mut().upsert(graph, source.uuid),
                HubEvent::Removed(source) => hub_state.borrow_mut().remove(source.uuid)
            })
        ));

        let edit_state = state.clone();
        subscriptions.push(graph.subscribe_all(Box::new(move |graph, update| {
            let affected = edit_state.borrow().affected(graph, update);
            if let Some(event_uuid) = affected {
                edit_state.borrow_mut().upsert(graph, event_uuid)
            }
        })));

        Self {state, subscriptions}
    }

    /// The cached events (borrow; cheap to take per render).
    pub fn events(&self) -> Ref<'_, EventCollection<ValueEvent>> {
        Ref::map(self.state.borrow(), |state| &state.events)
    }

    /// A cheap, cloneable read handle onto this collection's curve, decoupled from the subscriptions. The
    /// engine hands clones of these to its device-facing pull context (`host_automation` evaluates them),
    /// while this `ValueCollection` keeps owning the observers; cloning is just an `Rc` bump.
    pub fn curve(&self) -> ValueCurve {
        ValueCurve(self.state.clone())
    }

    pub fn len(&self) -> usize {
        self.state.borrow().events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.state.borrow().events.is_empty()
    }

    /// Unsubscribe the observers from `graph` (mirrors the TS adapter's `terminate`). Required for
    /// collections that come and go: a dropped `ValueCollection` whose observers stayed registered
    /// would keep firing on a cache nobody reads.
    pub fn terminate(self, graph: &mut BoxGraph) {
        for id in self.subscriptions {
            graph.unsubscribe(id);
        }
    }
}

/// A cloneable read-only handle onto a `ValueCollection`'s curve: it shares the same `Rc<RefCell<State>>`
/// the observers keep current, but owns no subscriptions, so cloning it is free and dropping it costs
/// nothing. `value_at` reads the live curve at evaluation time (the automation pull on a clock event), so
/// it always reflects the latest synced edits without any rebuild.
#[derive(Clone)]
pub struct ValueCurve(Rc<RefCell<State>>);

impl ValueCurve {
    /// The curve's value (the unit 0..1 the plugin maps) at `position`, or `fallback` when the curve is
    /// empty. Mirrors `AutomatableParameterFieldAdapter.valueAt` reading `track.valueAt`.
    pub fn value_at(&self, position: f64, fallback: f32) -> f32 {
        value_at(&self.0.borrow().events, position, fallback)
    }
}

/// The subject uuid of an update (the box it concerns).
fn affected_uuid(update: &Update) -> Uuid {
    match update {
        Update::Primitive {address, ..} | Update::Pointer {address, ..} => address.uuid,
        Update::New {uuid, ..} | Update::Delete {uuid, ..} => *uuid
    }
}
