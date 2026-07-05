//! Observe a `ValueEventCollectionBox`: keep an owned `EventCollection<ValueEvent>` in sync, built
//! incrementally from membership and edit events (the Rust counterpart of TS
//! `ValueEventCollectionBoxAdapter`). There is NO periodic rebuild: each subscription observer is
//! handed the consistent graph when it fires and mutates the cached collection directly.
//!
//!   - membership: a pointer-hub subscription on the collection's events hub. Its catch-up emits
//!     `Added` for every existing member (so `observe` needs no separate initial build), then
//!     `Added`/`Removed` as events connect / disconnect. `Added` reads that one event box and inserts
//!     it; `Removed` drops it.
//!   - edits: TARGETED per-member monitors (no all-updates listener). Each member event gets a `Parent`
//!     monitor on its own box (field edits) and a pointer-hub on its interpolation field (curve attach /
//!     detach), the latter adding a `Parent` monitor per attached curve box (slope edits). An edit thus
//!     dispatches to exactly the affected event's monitor, which re-reads and replaces that one event.
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
use boxgraph::subscription::{Deferred, HubEvent, Propagation, SubscriptionId};
use value::event::EventCollection;
use value::value::{value_at, ValueEvent};
use crate::value_events::{read_value_event, COLLECTION_EVENTS, EVENT_INTERPOLATION};

pub struct ValueCollection {
    state: Rc<RefCell<State>>,
    subscriptions: Vec<SubscriptionId>
}

/// The TARGETED subscriptions kept for one member event: its own field edits (`field`, a `Parent` monitor
/// on the event box), curve attach / detach (`interp`, a pointer-hub on the event's interpolation field),
/// and the slope edit of each attached curve box (`curves`, a `Parent` monitor per curve box).
struct EventSubs {
    field: SubscriptionId,
    interp: SubscriptionId,
    curves: BTreeMap<Uuid, SubscriptionId>
}

/// The shared cache the observers maintain plus the per-event subscription bookkeeping.
struct State {
    events: EventCollection<ValueEvent>,
    index: BTreeMap<Uuid, ValueEvent>, // event uuid -> its current ValueEvent (for remove / replace by uuid)
    subs: BTreeMap<Uuid, EventSubs>
}

impl State {
    fn new() -> Self {
        Self {events: EventCollection::new(), index: BTreeMap::new(), subs: BTreeMap::new()}
    }

    /// Read `event_uuid` from the graph and (re)place it in both structures. `read_value_event` reads the
    /// event's interpolation INCLUDING any attached curve box's slope, so an upsert always reflects the
    /// current curve.
    fn upsert(&mut self, graph: &BoxGraph, event_uuid: Uuid) {
        // The per-event `Parent` monitor (and a curve box's monitor) can fire when the event box is being
        // DELETED; it is gone by dispatch time, so reading its mandatory fields would panic — skip. The hub
        // `Removed` that follows drops the event from the set.
        if graph.find_box(&event_uuid).is_none() {
            return;
        }
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
}

impl ValueCollection {
    /// Observe a value-event collection with TARGETED subscriptions only (no all-updates listener): the
    /// events pointer-hub for membership, and per member event a `Parent` monitor on the event box (field
    /// edits) plus a pointer-hub on its interpolation field (curve attach / detach), the latter adding a
    /// `Parent` monitor on each attached curve box (slope edits). Each edit dispatches to exactly one monitor.
    pub fn observe(graph: &mut BoxGraph, collection: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();
        let hub_state = state.clone();
        let hub_deferred = graph.deferred();
        subscriptions.push(graph.subscribe_pointer_hub(
            Address::of(collection, vec![COLLECTION_EVENTS]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => join_event(&hub_state, &hub_deferred, graph, source.uuid),
                HubEvent::Removed(source) => leave_event(&hub_state, &hub_deferred, source.uuid)
            })
        ));
        // Register the subs the catch-up queued for existing members (we hold `&mut graph`, outside dispatch);
        // later joins / curve attaches are flushed by the transaction's dispatch.
        graph.apply_deferred();
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
        for (_, subs) in core::mem::take(&mut self.state.borrow_mut().subs) {
            graph.unsubscribe(subs.field);
            graph.unsubscribe(subs.interp);
            for (_, id) in subs.curves {
                graph.unsubscribe(id);
            }
        }
    }
}

/// A member event joined: read it, then add its targeted subscriptions — a `Parent` monitor on the event
/// box (field edits) and a pointer-hub on its interpolation field (curve attach / detach). Deferred, so
/// they register after the current dispatch.
fn join_event(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, event_uuid: Uuid) {
    state.borrow_mut().upsert(graph, event_uuid);
    let field_state = state.clone();
    let field = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(event_uuid),
        Box::new(move |graph, _update| field_state.borrow_mut().upsert(graph, event_uuid)));
    let interp_state = state.clone();
    let interp_deferred = deferred.clone();
    let interp = deferred.subscribe_pointer_hub(Address::of(event_uuid, vec![EVENT_INTERPOLATION]),
        Box::new(move |graph, event| match event {
            HubEvent::Added(curve) => attach_curve(&interp_state, &interp_deferred, graph, event_uuid, curve.uuid),
            HubEvent::Removed(curve) => detach_curve(&interp_state, &interp_deferred, graph, event_uuid, curve.uuid)
        }));
    state.borrow_mut().subs.insert(event_uuid, EventSubs {field, interp, curves: BTreeMap::new()});
}

/// A member event left: drop it and unsubscribe its field / interpolation monitors and every curve monitor.
fn leave_event(state: &Rc<RefCell<State>>, deferred: &Deferred, event_uuid: Uuid) {
    let mut state = state.borrow_mut();
    state.remove(event_uuid);
    if let Some(subs) = state.subs.remove(&event_uuid) {
        deferred.unsubscribe(subs.field);
        deferred.unsubscribe(subs.interp);
        for (_, id) in subs.curves {
            deferred.unsubscribe(id);
        }
    }
}

/// A curve box attached to an event's interpolation: re-read the event (now curved) and watch the curve
/// box for slope edits with a `Parent` monitor.
fn attach_curve(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, event_uuid: Uuid, curve_uuid: Uuid) {
    state.borrow_mut().upsert(graph, event_uuid);
    let slope_state = state.clone();
    let slope = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(curve_uuid),
        Box::new(move |graph, _update| slope_state.borrow_mut().upsert(graph, event_uuid)));
    if let Some(subs) = state.borrow_mut().subs.get_mut(&event_uuid) {
        subs.curves.insert(curve_uuid, slope);
    }
}

/// A curve box detached: drop its slope monitor and re-read the event (back to its plain interpolation).
fn detach_curve(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, event_uuid: Uuid, curve_uuid: Uuid) {
    if let Some(subs) = state.borrow_mut().subs.get_mut(&event_uuid) {
        if let Some(id) = subs.curves.remove(&curve_uuid) {
            deferred.unsubscribe(id);
        }
    }
    state.borrow_mut().upsert(graph, event_uuid);
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

    /// Like [`Self::value_at`] but `None` when the curve is EMPTY, so the caller can fall back to the
    /// parameter's STORED field value (TS's fallback is `getUnitValue()`, the mapped field).
    pub fn value_at_opt(&self, position: f64) -> Option<f32> {
        let state = self.0.borrow();
        if state.events.is_empty() { None } else { Some(value_at(&state.events, position, 0.0)) }
    }

    /// The FIRST event's value when it sits exactly at local position 0 (TS `ValueRegionBoxAdapter.
    /// incomingValue`'s `greaterEqual(0)` probe). With STACKED events at 0 this is the one first BY INDEX —
    /// `value_at(0)` floors to the LAST of the stack, a different value.
    pub fn incoming_zero_value(&self) -> Option<f32> {
        self.0.borrow().events.greater_equal(0.0)
            .filter(|event| event.position == 0.0).map(|event| event.value)
    }
}
