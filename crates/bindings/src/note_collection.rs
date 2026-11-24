//! Observe a `NoteEventCollectionBox`: keep an owned `EventCollection<NoteEvent>` in sync, built
//! incrementally from membership and edit events. The note counterpart of `ValueCollection` (and the
//! TS `NoteEventCollectionBoxAdapter`). A note also reads its chance box (with its group) and its repeat
//! box, so each member watches those boxes too and is re-read when they change.

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
use value::note::NoteEvent;
use crate::note_events::{aux_box, group_box, read_note_event, COLLECTION_EVENTS, NOTE_RANDOM, NOTE_SPLIT};

// Clonable: `state` is shared by `Rc`, so a clone reads the same live collection. A binding keeps one
// clone for teardown (`terminate` unsubscribes by id) while the sequencer reads from another.
#[derive(Clone)]
pub struct NoteCollection {
    state: Rc<RefCell<State>>,
    subscriptions: Vec<SubscriptionId>
}

/// The TARGETED subscriptions of one member note: its own field edits, the attach / detach of its chance
/// and repeat boxes (the hubs), and `aux`, the monitors on the attached chance, group and repeat boxes.
struct NoteSubs {
    field: SubscriptionId,
    random: SubscriptionId,
    split: SubscriptionId,
    aux: Vec<SubscriptionId>
}

/// The shared cache the observers maintain: the position-sorted collection, a uuid → note index (so an
/// edit can remove / replace a note by uuid, since the collection is keyed by position), and the per-note
/// subscriptions to drop when the note leaves.
struct State {
    events: EventCollection<NoteEvent>,
    index: BTreeMap<Uuid, NoteEvent>,
    subs: BTreeMap<Uuid, NoteSubs>
}

impl State {
    fn new() -> Self {
        Self {events: EventCollection::new(), index: BTreeMap::new(), subs: BTreeMap::new()}
    }

    fn upsert(&mut self, graph: &BoxGraph, note_uuid: Uuid) {
        // The per-note edit monitor is `Parent` on the note box, so it also fires when the box is DELETED
        // (its own deletion is an update at its address). The box is gone by dispatch time, so reading its
        // mandatory fields would panic — skip; the hub `Removed` that follows drops the note from the set.
        if graph.find_box(&note_uuid).is_none() {
            return;
        }
        let note = read_note_event(graph, note_uuid);
        if let Some(previous) = self.index.insert(note_uuid, note) {
            self.events.remove(&previous);
        }
        self.events.add(note);
    }

    fn remove(&mut self, note_uuid: Uuid) {
        if let Some(previous) = self.index.remove(&note_uuid) {
            self.events.remove(&previous);
        }
    }
}

impl NoteCollection {
    /// Observe a note-event collection: membership via the pointer-hub, and a TARGETED per-note edit
    /// subscription added when a note joins (deferred, applied after dispatch / reconcile) and dropped when
    /// it leaves. No all-updates listener — a note edit dispatches only to that note's own monitor.
    pub fn observe(graph: &mut BoxGraph, collection: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();

        let hub_state = state.clone();
        let deferred = graph.deferred();
        subscriptions.push(graph.subscribe_pointer_hub(
            Address::of(collection, vec![COLLECTION_EVENTS]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => join_note(&hub_state, &deferred, graph, source.uuid),
                HubEvent::Removed(source) => leave_note(&hub_state, &deferred, source.uuid)
            })
        ));
        // The catch-up above queued a per-note edit sub for each existing member; register them now (we
        // hold `&mut graph`, outside any dispatch). Later joins are flushed by the transaction's dispatch.
        graph.apply_deferred();
        Self {state, subscriptions}
    }

    /// The cached notes (borrow; cheap to take per render).
    pub fn events(&self) -> Ref<'_, EventCollection<NoteEvent>> {
        Ref::map(self.state.borrow(), |state| &state.events)
    }

    pub fn len(&self) -> usize {
        self.state.borrow().events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.state.borrow().events.is_empty()
    }

    /// Unsubscribe the hub observer and every per-note edit monitor (mirrors the TS adapter's `terminate`).
    pub fn terminate(self, graph: &mut BoxGraph) {
        for id in self.subscriptions {
            graph.unsubscribe(id);
        }
        for (_, subs) in core::mem::take(&mut self.state.borrow_mut().subs) {
            graph.unsubscribe(subs.field);
            graph.unsubscribe(subs.random);
            graph.unsubscribe(subs.split);
            for id in subs.aux {
                graph.unsubscribe(id);
            }
        }
    }
}

/// A member note joined: read it, watch its fields, the attach / detach of its chance and repeat boxes,
/// and the boxes attached right now. Deferred, so they register after the current dispatch.
fn join_note(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, note: Uuid) {
    state.borrow_mut().upsert(graph, note);
    let field_state = state.clone();
    let field = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(note),
        Box::new(move |graph, _update| field_state.borrow_mut().upsert(graph, note)));
    let hub = |key: u16| {
        let hub_state = state.clone();
        let hub_deferred = deferred.clone();
        deferred.subscribe_pointer_hub(Address::of(note, vec![key]),
            Box::new(move |graph, _event| rewire(&hub_state, &hub_deferred, graph, note)))
    };
    let random = hub(NOTE_RANDOM);
    let split = hub(NOTE_SPLIT);
    let aux = watch_aux(state, deferred, graph, note);
    state.borrow_mut().subs.insert(note, NoteSubs {field, random, split, aux});
}

/// A member note left: drop it and every subscription it holds.
fn leave_note(state: &Rc<RefCell<State>>, deferred: &Deferred, note: Uuid) {
    let mut state = state.borrow_mut();
    state.remove(note);
    if let Some(subs) = state.subs.remove(&note) {
        deferred.unsubscribe(subs.field);
        deferred.unsubscribe(subs.random);
        deferred.unsubscribe(subs.split);
        for id in subs.aux {
            deferred.unsubscribe(id);
        }
    }
}

/// The chance, group or repeat box of a note changed: watch the boxes attached now and re-read the note.
fn rewire(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, note: Uuid) {
    let previous = match state.borrow_mut().subs.get_mut(&note) {
        Some(subs) => core::mem::take(&mut subs.aux),
        None => return
    };
    for id in previous {
        deferred.unsubscribe(id);
    }
    let aux = watch_aux(state, deferred, graph, note);
    let mut borrowed = state.borrow_mut();
    if let Some(subs) = borrowed.subs.get_mut(&note) {
        subs.aux = aux;
    }
    borrowed.upsert(graph, note);
}

/// Monitors on the attached boxes: the chance box (its group may change, so it rewires), the group (chance,
/// mode and its members, which set rank and size) and the repeat box.
fn watch_aux(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, note: Uuid) -> Vec<SubscriptionId> {
    let mut ids = Vec::new();
    if let Some(chance) = aux_box(graph, note, NOTE_RANDOM) {
        let chance_state = state.clone();
        let chance_deferred = deferred.clone();
        ids.push(deferred.subscribe_vertex(Propagation::Parent, Address::box_of(chance),
            Box::new(move |graph, _update| rewire(&chance_state, &chance_deferred, graph, note))));
    }
    if let Some(group) = group_box(graph, note) {
        let group_state = state.clone();
        ids.push(deferred.subscribe_vertex(Propagation::Parent, Address::box_of(group),
            Box::new(move |graph, _update| group_state.borrow_mut().upsert(graph, note))));
        let members_state = state.clone();
        ids.push(deferred.subscribe_pointer_hub(Address::box_of(group),
            Box::new(move |graph, _event| members_state.borrow_mut().upsert(graph, note))));
    }
    if let Some(repeat) = aux_box(graph, note, NOTE_SPLIT) {
        let repeat_state = state.clone();
        ids.push(deferred.subscribe_vertex(Propagation::Parent, Address::box_of(repeat),
            Box::new(move |graph, _update| repeat_state.borrow_mut().upsert(graph, note))));
    }
    ids
}
