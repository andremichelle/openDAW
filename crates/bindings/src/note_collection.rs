//! Observe a `NoteEventCollectionBox`: keep an owned `EventCollection<NoteEvent>` in sync, built
//! incrementally from membership and edit events. The note counterpart of `ValueCollection` (and the
//! TS `NoteEventCollectionBoxAdapter`); simpler, because notes have no curve boxes — an edit affects
//! the collection only if it touches a member note directly.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Ref, RefCell};
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, Propagation, SubscriptionId};
use value::event::EventCollection;
use value::note::NoteEvent;
use crate::note_events::{read_note_event, COLLECTION_EVENTS};

// Clonable: `state` is shared by `Rc`, so a clone reads the same live collection. A binding keeps one
// clone for teardown (`terminate` unsubscribes by id) while the sequencer reads from another.
#[derive(Clone)]
pub struct NoteCollection {
    state: Rc<RefCell<State>>,
    subscriptions: Vec<SubscriptionId>
}

/// The shared cache the observers maintain: the position-sorted collection, a uuid → note index (so an
/// edit can remove / replace a note by uuid, since the collection is keyed by position), and the per-note
/// TARGETED edit subscription (one `Parent` monitor per member note) to drop when the note leaves.
struct State {
    events: EventCollection<NoteEvent>,
    index: BTreeMap<Uuid, NoteEvent>,
    edit_subs: BTreeMap<Uuid, SubscriptionId>
}

impl State {
    fn new() -> Self {
        Self {events: EventCollection::new(), index: BTreeMap::new(), edit_subs: BTreeMap::new()}
    }

    fn upsert(&mut self, graph: &BoxGraph, note_uuid: Uuid) {
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
                HubEvent::Added(source) => {
                    let note_uuid = source.uuid;
                    hub_state.borrow_mut().upsert(graph, note_uuid);
                    let edit_state = hub_state.clone();
                    let id = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(note_uuid),
                        Box::new(move |graph, _update| edit_state.borrow_mut().upsert(graph, note_uuid)));
                    hub_state.borrow_mut().edit_subs.insert(note_uuid, id);
                }
                HubEvent::Removed(source) => {
                    hub_state.borrow_mut().remove(source.uuid);
                    if let Some(id) = hub_state.borrow_mut().edit_subs.remove(&source.uuid) {
                        deferred.unsubscribe(id);
                    }
                }
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
        for (_, id) in core::mem::take(&mut self.state.borrow_mut().edit_subs) {
            graph.unsubscribe(id);
        }
    }
}
