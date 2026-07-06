//! The SIGNATURE TRACK: time-signature changes over the timeline, the engine port of the TS
//! `SignatureTrackAdapter` (`iterateAll` / `signatureAt`). The observer keeps an owned ACCUMULATED
//! event list in sync with the box graph (the storage signature, the track's `enabled` flag and the
//! `SignatureEventBox` members), rebuilt inside subscription dispatch (off the render path). The
//! metronome walks the list pair-wise per block and the recording count-in resolves the signature
//! in effect at the recording start.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Ref, RefCell};
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{Deferred, HubEvent, Propagation, SubscriptionId};
use dsp::ppqn::from_signature;

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
const TIMELINE_SIGNATURE: u16 = 10; // TimelineBox.signature = {nominator (1), denominator (2)}
const SIGNATURE_NOMINATOR: u16 = 1;
const SIGNATURE_DENOMINATOR: u16 = 2;
const TIMELINE_SIGNATURE_TRACK: u16 = 23; // TimelineBox.signatureTrack = {events (1, hub), enabled (20)}
const TRACK_EVENTS: u16 = 1;
const TRACK_ENABLED: u16 = 20;
const EVENT_INDEX: u16 = 9; // SignatureEventBox.index (Int32)
const EVENT_RELATIVE_POSITION: u16 = 10; // SignatureEventBox.relativePosition (Int32, bars since the previous event)
const EVENT_NOMINATOR: u16 = 21; // SignatureEventBox.nominator (Int32)
const EVENT_DENOMINATOR: u16 = 22; // SignatureEventBox.denominator (Int32)

/// One entry of the accumulated signature list (the TS `SignatureEvent`): `index` -1 is the STORAGE
/// signature at pulse 0 (`iterateAll`'s first yield), every later entry a `SignatureEventBox`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SignatureEvent {
    pub index: i32,
    pub accumulated_ppqn: f64,
    pub nominator: i32,
    pub denominator: i32
}

/// A member `SignatureEventBox`'s raw fields; the accumulation happens in `rebuild`.
struct Member {
    index: i32,
    relative_position: i32,
    nominator: i32,
    denominator: i32
}

/// The shared cache the observers maintain plus the per-member subscription bookkeeping.
struct State {
    storage_nominator: i32,
    storage_denominator: i32,
    enabled: bool,
    members: BTreeMap<Uuid, Member>,
    subs: BTreeMap<Uuid, SubscriptionId>,
    events: Vec<SignatureEvent>
}

impl State {
    fn new() -> Self {
        let mut state = Self {
            storage_nominator: 4,
            storage_denominator: 4,
            enabled: true,
            members: BTreeMap::new(),
            subs: BTreeMap::new(),
            events: Vec::new()
        };
        state.rebuild();
        state
    }

    /// Rebuild the accumulated list (TS `iterateAll`): the storage signature at pulse 0 first, then —
    /// only while the track is ENABLED — each member (by `index`) at the previous signature's bar
    /// length times its `relativePosition`, carrying nominator/denominator forward.
    fn rebuild(&mut self) {
        self.events.clear();
        let (mut nominator, mut denominator) = (self.storage_nominator, self.storage_denominator);
        self.events.push(SignatureEvent {index: -1, accumulated_ppqn: 0.0, nominator, denominator});
        if !self.enabled {
            return;
        }
        let mut ordered: Vec<&Member> = self.members.values().collect();
        ordered.sort_by_key(|member| member.index);
        let mut accumulated = 0.0;
        for member in ordered {
            accumulated += from_signature(nominator, denominator) * member.relative_position as f64;
            nominator = member.nominator;
            denominator = member.denominator;
            self.events.push(SignatureEvent {index: member.index, accumulated_ppqn: accumulated, nominator, denominator});
        }
    }

    /// Read `event_uuid` from the graph and (re)place its member entry, then rebuild. Skips a box
    /// already gone by dispatch time (a delete's `Parent` monitor); the hub `Removed` drops it.
    fn upsert(&mut self, graph: &BoxGraph, event_uuid: Uuid) {
        if graph.find_box(&event_uuid).is_none() {
            return;
        }
        let field = |key: u16| graph.field_value(&Address::of(event_uuid, vec![key])).and_then(FieldValue::as_int32);
        self.members.insert(event_uuid, Member {
            index: field(EVENT_INDEX).unwrap_or(0),
            relative_position: field(EVENT_RELATIVE_POSITION).unwrap_or(1),
            nominator: field(EVENT_NOMINATOR).unwrap_or(4),
            denominator: field(EVENT_DENOMINATOR).unwrap_or(4)
        });
        self.rebuild();
    }

    fn remove(&mut self, event_uuid: Uuid) {
        self.members.remove(&event_uuid);
        self.rebuild();
    }
}

pub struct SignatureTrack {
    state: Rc<RefCell<State>>,
    #[allow(dead_code)] // the timeline is a bind-once singleton; the subscriptions live for the session
    subscriptions: Vec<SubscriptionId>
}

impl SignatureTrack {
    /// Observe the timeline's signature (storage nominator/denominator), the signature track's
    /// `enabled` flag and its events hub; each member `SignatureEventBox` gets a `Parent` monitor for
    /// field edits. Any change rebuilds the accumulated list (mirrors the TS adapter's changeNotifier).
    pub fn observe(graph: &mut BoxGraph, timeline: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();
        let nominator_state = state.clone();
        subscriptions.push(graph.catchup_and_subscribe(
            Address::of(timeline, vec![TIMELINE_SIGNATURE, SIGNATURE_NOMINATOR]), move |value| {
                if let Some(value) = value.as_int32() {
                    let mut state = nominator_state.borrow_mut();
                    state.storage_nominator = value;
                    state.rebuild();
                }
            }));
        let denominator_state = state.clone();
        subscriptions.push(graph.catchup_and_subscribe(
            Address::of(timeline, vec![TIMELINE_SIGNATURE, SIGNATURE_DENOMINATOR]), move |value| {
                if let Some(value) = value.as_int32() {
                    let mut state = denominator_state.borrow_mut();
                    state.storage_denominator = value;
                    state.rebuild();
                }
            }));
        let enabled_state = state.clone();
        subscriptions.push(graph.catchup_and_subscribe(
            Address::of(timeline, vec![TIMELINE_SIGNATURE_TRACK, TRACK_ENABLED]), move |value| {
                if let Some(value) = value.as_bool() {
                    let mut state = enabled_state.borrow_mut();
                    state.enabled = value;
                    state.rebuild();
                }
            }));
        let hub_state = state.clone();
        let hub_deferred = graph.deferred();
        subscriptions.push(graph.subscribe_pointer_hub(
            Address::of(timeline, vec![TIMELINE_SIGNATURE_TRACK, TRACK_EVENTS]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => join_event(&hub_state, &hub_deferred, graph, source.uuid),
                HubEvent::Removed(source) => leave_event(&hub_state, &hub_deferred, source.uuid)
            })
        ));
        // Register the subs the catch-up queued for existing members (we hold `&mut graph`, outside
        // dispatch); later joins are flushed by the transaction's dispatch.
        graph.apply_deferred();
        Self {state, subscriptions}
    }

    /// The accumulated signature events (borrow; cheap per render). Always non-empty: entry 0 is the
    /// storage signature at pulse 0.
    pub fn events(&self) -> Ref<'_, Vec<SignatureEvent>> {
        Ref::map(self.state.borrow(), |state| &state.events)
    }

    /// The signature in effect at `position` (TS `signatureAt`): the last event at or before it —
    /// the storage signature when the track is empty or disabled.
    pub fn signature_at(&self, position: f64) -> (i32, i32) {
        let state = self.state.borrow();
        let position = if position < 0.0 {0.0} else {position};
        let mut result = (state.storage_nominator, state.storage_denominator);
        for event in &state.events {
            if event.accumulated_ppqn > position {
                break;
            }
            result = (event.nominator, event.denominator);
        }
        result
    }
}

/// A member event joined: read it and watch its box for field edits with a `Parent` monitor
/// (deferred, so it registers after the current dispatch).
fn join_event(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, event_uuid: Uuid) {
    state.borrow_mut().upsert(graph, event_uuid);
    let field_state = state.clone();
    let field = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(event_uuid),
        Box::new(move |graph, _update| field_state.borrow_mut().upsert(graph, event_uuid)));
    state.borrow_mut().subs.insert(event_uuid, field);
}

/// A member event left: drop it and unsubscribe its field monitor.
fn leave_event(state: &Rc<RefCell<State>>, deferred: &Deferred, event_uuid: Uuid) {
    let mut state = state.borrow_mut();
    state.remove(event_uuid);
    if let Some(id) = state.subs.remove(&event_uuid) {
        deferred.unsubscribe(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxgraph::boxes::{GraphBox, Registry};
    use boxgraph::field::Fields;
    use boxgraph::updates::Update;

    const TIMELINE: Uuid = [1u8; 16];
    const EVENT_A: Uuid = [2u8; 16];
    const EVENT_B: Uuid = [3u8; 16];

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    fn timeline_box(nominator: i32, denominator: i32, enabled: bool) -> GraphBox {
        graph_box(TIMELINE, "TimelineBox", &[
            (TIMELINE_SIGNATURE, FieldValue::Object(BTreeMap::from([
                (SIGNATURE_NOMINATOR, FieldValue::Int32(nominator)),
                (SIGNATURE_DENOMINATOR, FieldValue::Int32(denominator))
            ]))),
            (TIMELINE_SIGNATURE_TRACK, FieldValue::Object(BTreeMap::from([
                (TRACK_EVENTS, FieldValue::Hook),
                (TRACK_ENABLED, FieldValue::Boolean(enabled))
            ])))
        ])
    }

    fn event_box(uuid: Uuid, index: i32, relative_position: i32, nominator: i32, denominator: i32) -> GraphBox {
        graph_box(uuid, "SignatureEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_SIGNATURE_TRACK, TRACK_EVENTS])))),
            (EVENT_INDEX, FieldValue::Int32(index)),
            (EVENT_RELATIVE_POSITION, FieldValue::Int32(relative_position)),
            (EVENT_NOMINATOR, FieldValue::Int32(nominator)),
            (EVENT_DENOMINATOR, FieldValue::Int32(denominator))
        ])
    }

    #[test]
    fn accumulates_initial_events_from_the_storage_signature() {
        // 4/4 storage, 3/4 after ONE 4/4 bar (3840), 7/8 after TWO 3/4 bars (3840 + 2 * 2880).
        let mut graph = BoxGraph::from_boxes(vec![
            timeline_box(4, 4, true),
            event_box(EVENT_A, 0, 1, 3, 4),
            event_box(EVENT_B, 1, 2, 7, 8)
        ]);
        let track = SignatureTrack::observe(&mut graph, TIMELINE);
        let events = track.events().clone();
        assert_eq!(events, vec![
            SignatureEvent {index: -1, accumulated_ppqn: 0.0, nominator: 4, denominator: 4},
            SignatureEvent {index: 0, accumulated_ppqn: 3840.0, nominator: 3, denominator: 4},
            SignatureEvent {index: 1, accumulated_ppqn: 3840.0 + 2.0 * 2880.0, nominator: 7, denominator: 8}
        ]);
    }

    #[test]
    fn signature_at_resolves_the_effective_signature() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(4, 4, true), event_box(EVENT_A, 0, 1, 3, 4)]);
        let track = SignatureTrack::observe(&mut graph, TIMELINE);
        assert_eq!(track.signature_at(-500.0), (4, 4), "negative positions clamp to 0 (TS Math.max)");
        assert_eq!(track.signature_at(0.0), (4, 4));
        assert_eq!(track.signature_at(3839.0), (4, 4));
        assert_eq!(track.signature_at(3840.0), (3, 4), "the event position itself already uses the new signature");
        assert_eq!(track.signature_at(90000.0), (3, 4));
    }

    #[test]
    fn a_disabled_track_yields_only_the_storage_signature() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(6, 8, false), event_box(EVENT_A, 0, 1, 3, 4)]);
        let track = SignatureTrack::observe(&mut graph, TIMELINE);
        assert_eq!(track.events().len(), 1, "iterateAll returns after the storage yield when disabled");
        assert_eq!(track.signature_at(90000.0), (6, 8));
    }

    #[test]
    fn rebuilds_on_member_field_edits_and_membership_changes() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(4, 4, true), event_box(EVENT_A, 0, 1, 3, 4)]);
        let track = SignatureTrack::observe(&mut graph, TIMELINE);
        let registry = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(EVENT_A, vec![EVENT_RELATIVE_POSITION]),
            old: FieldValue::Int32(1),
            new: FieldValue::Int32(3)
        }], &registry).unwrap();
        assert_eq!(track.events()[1].accumulated_ppqn, 3.0 * 3840.0, "a relativePosition edit re-accumulates");
        graph.transaction(&[Update::Primitive {
            address: Address::of(EVENT_A, vec![1]),
            old: FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_SIGNATURE_TRACK, TRACK_EVENTS]))),
            new: FieldValue::Pointer(None)
        }], &registry).unwrap();
        assert_eq!(track.events().len(), 1, "a disconnected member leaves the list");
        assert_eq!(track.signature_at(90000.0), (4, 4));
    }

    #[test]
    fn rebuilds_on_storage_signature_and_enabled_edits() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(4, 4, true), event_box(EVENT_A, 0, 1, 3, 4)]);
        let track = SignatureTrack::observe(&mut graph, TIMELINE);
        let registry = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(TIMELINE, vec![TIMELINE_SIGNATURE, SIGNATURE_DENOMINATOR]),
            old: FieldValue::Int32(4),
            new: FieldValue::Int32(8)
        }], &registry).unwrap();
        assert_eq!(track.events()[0].denominator, 8);
        assert_eq!(track.events()[1].accumulated_ppqn, from_signature(4, 8), "the first event moves with the storage bar length");
        graph.transaction(&[Update::Primitive {
            address: Address::of(TIMELINE, vec![TIMELINE_SIGNATURE_TRACK, TRACK_ENABLED]),
            old: FieldValue::Boolean(true),
            new: FieldValue::Boolean(false)
        }], &registry).unwrap();
        assert_eq!(track.events().len(), 1, "disabling the track drops the events live");
    }
}
