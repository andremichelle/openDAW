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
use boxgraph::subscription::{HubEvent, SubscriptionId};
use boxgraph::updates::Update;
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

/// The shared cache the observers maintain: the position-sorted collection plus a uuid → note index
/// (so an edit can remove / replace a note by uuid, since the collection is keyed by position).
struct State {
    events: EventCollection<NoteEvent>,
    index: BTreeMap<Uuid, NoteEvent>
}

impl State {
    fn new() -> Self {
        Self {events: EventCollection::new(), index: BTreeMap::new()}
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

    /// The member note an update affects, if any (its own box; notes have no satellite boxes).
    fn affected(&self, update: &Update) -> Option<Uuid> {
        let uuid = update_uuid(update);
        if self.index.contains_key(&uuid) {Some(uuid)} else {None}
    }
}

impl NoteCollection {
    /// Subscribe to the collection and build it from the pointer-hub catch-up (`Added` per existing
    /// member) plus all-updates edits to member notes.
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
            let affected = edit_state.borrow().affected(update);
            if let Some(uuid) = affected {
                edit_state.borrow_mut().upsert(graph, uuid)
            }
        })));

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

    /// Unsubscribe the observers from `graph` (mirrors the TS adapter's `terminate`).
    pub fn terminate(self, graph: &mut BoxGraph) {
        for id in self.subscriptions {
            graph.unsubscribe(id);
        }
    }
}

/// The subject uuid of an update (the box it concerns).
fn update_uuid(update: &Update) -> Uuid {
    match update {
        Update::Primitive {address, ..} | Update::Pointer {address, ..} => address.uuid,
        Update::New {uuid, ..} | Update::Delete {uuid, ..} => *uuid
    }
}
