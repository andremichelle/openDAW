//! The MARKER TRACK: timeline markers whose sections repeat `plays` times, the engine port of the TS
//! `MarkerTrackAdapter` (an `EventCollection<MarkerBoxAdapter>` sorted by position). The observer keeps
//! an owned position-sorted list of `transport::Marker` in sync with the box graph (the hub members and
//! their field edits), rebuilt inside subscription dispatch (off the render path). Any member change
//! raises `changed` (TS `changeNotifier` -> `BlockRenderer.#someMarkersChanged`); the `enabled` flag is
//! tracked separately and does NOT raise it (TS gates only the marker ACTION on it, edits to it never
//! dispatch through the track notifier).

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
use transport::transport::Marker;

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
const TIMELINE_MARKER_TRACK: u16 = 21; // TimelineBox.markerTrack = {markers (1, hub), enabled (20)}
const TRACK_MARKERS: u16 = 1;
const TRACK_ENABLED: u16 = 20;
const MARKER_POSITION: u16 = 2; // MarkerBox.position (Int32, ppqn)
const MARKER_PLAYS: u16 = 3; // MarkerBox.plays (Int32, 0 = the section repeats forever)

/// A member `MarkerBox`'s raw fields; the sorting happens in `rebuild`.
struct Member {
    position: i32,
    plays: i32
}

/// The shared cache the observers maintain plus the per-member subscription bookkeeping.
struct State {
    enabled: bool,
    members: BTreeMap<Uuid, Member>,
    subs: BTreeMap<Uuid, SubscriptionId>,
    events: Vec<Marker>,
    changed: bool
}

impl State {
    fn new() -> Self {
        Self {
            enabled: true,
            members: BTreeMap::new(),
            subs: BTreeMap::new(),
            events: Vec::new(),
            changed: false
        }
    }

    /// Rebuild the position-sorted marker list. Position ties break by uuid (deterministic; TS keeps
    /// insertion order among equals — equal positions are a degenerate arrangement either way).
    fn rebuild(&mut self) {
        self.events.clear();
        for (uuid, member) in self.members.iter() {
            self.events.push(Marker {uuid: *uuid, position: member.position as f64, plays: member.plays});
        }
        self.events.sort_by(|left, right| left.position.total_cmp(&right.position));
        self.changed = true;
    }

    /// Read `marker_uuid` from the graph and (re)place its member entry, then rebuild. Skips a box
    /// already gone by dispatch time (a delete's `Parent` monitor); the hub `Removed` drops it.
    fn upsert(&mut self, graph: &BoxGraph, marker_uuid: Uuid) {
        if graph.find_box(&marker_uuid).is_none() {
            return;
        }
        let field = |key: u16| graph.field_value(&Address::of(marker_uuid, vec![key])).and_then(FieldValue::as_int32);
        self.members.insert(marker_uuid, Member {
            position: field(MARKER_POSITION).unwrap_or(0),
            plays: field(MARKER_PLAYS).unwrap_or(1)
        });
        self.rebuild();
    }

    fn remove(&mut self, marker_uuid: Uuid) {
        self.members.remove(&marker_uuid);
        self.rebuild();
    }
}

pub struct MarkerTrack {
    state: Rc<RefCell<State>>,
    #[allow(dead_code)] // the timeline is a bind-once singleton; the subscriptions live for the session
    subscriptions: Vec<SubscriptionId>
}

impl MarkerTrack {
    /// Observe the marker track's `enabled` flag and its markers hub; each member `MarkerBox` gets a
    /// `Parent` monitor for field edits. Any membership / field change rebuilds the sorted list and
    /// raises `changed` (mirrors the TS adapter's changeNotifier feeding `#someMarkersChanged`).
    pub fn observe(graph: &mut BoxGraph, timeline: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();
        let enabled_state = state.clone();
        subscriptions.push(graph.catchup_and_subscribe(
            Address::of(timeline, vec![TIMELINE_MARKER_TRACK, TRACK_ENABLED]), move |value| {
                if let Some(value) = value.as_bool() {
                    enabled_state.borrow_mut().enabled = value;
                }
            }));
        let hub_state = state.clone();
        let hub_deferred = graph.deferred();
        subscriptions.push(graph.subscribe_pointer_hub(
            Address::of(timeline, vec![TIMELINE_MARKER_TRACK, TRACK_MARKERS]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => join_marker(&hub_state, &hub_deferred, graph, source.uuid),
                HubEvent::Removed(source) => leave_marker(&hub_state, &hub_deferred, source.uuid)
            })
        ));
        // Register the subs the catch-up queued for existing members (we hold `&mut graph`, outside
        // dispatch); later joins are flushed by the transaction's dispatch.
        graph.apply_deferred();
        // The initial catch-up is not an EDIT: TS constructs the adapters before the BlockRenderer
        // subscribes, so the pre-existing markers never raise `#someMarkersChanged`.
        state.borrow_mut().changed = false;
        Self {state, subscriptions}
    }

    /// The position-sorted markers (borrow; cheap per render), the transport's action slice.
    pub fn markers(&self) -> Ref<'_, Vec<Marker>> {
        Ref::map(self.state.borrow(), |state| &state.events)
    }

    /// The track's `enabled` flag (gates only the marker ACTION, TS `markerTrack.enabled`).
    pub fn enabled(&self) -> bool {
        self.state.borrow().enabled
    }

    /// True when the marker set changed since the last take (TS `#someMarkersChanged`); reading resets.
    pub fn take_changed(&self) -> bool {
        core::mem::replace(&mut self.state.borrow_mut().changed, false)
    }
}

/// A member marker joined: read it and watch its box for field edits with a `Parent` monitor
/// (deferred, so it registers after the current dispatch).
fn join_marker(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, marker_uuid: Uuid) {
    state.borrow_mut().upsert(graph, marker_uuid);
    let field_state = state.clone();
    let field = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(marker_uuid),
        Box::new(move |graph, _update| field_state.borrow_mut().upsert(graph, marker_uuid)));
    state.borrow_mut().subs.insert(marker_uuid, field);
}

/// A member marker left: drop it and unsubscribe its field monitor.
fn leave_marker(state: &Rc<RefCell<State>>, deferred: &Deferred, marker_uuid: Uuid) {
    let mut state = state.borrow_mut();
    state.remove(marker_uuid);
    if let Some(id) = state.subs.remove(&marker_uuid) {
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
    const MARKER_A: Uuid = [2u8; 16];
    const MARKER_B: Uuid = [3u8; 16];

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    fn timeline_box(enabled: bool) -> GraphBox {
        graph_box(TIMELINE, "TimelineBox", &[
            (TIMELINE_MARKER_TRACK, FieldValue::Object(BTreeMap::from([
                (TRACK_MARKERS, FieldValue::Hook),
                (TRACK_ENABLED, FieldValue::Boolean(enabled))
            ])))
        ])
    }

    fn marker_box(uuid: Uuid, position: i32, plays: i32) -> GraphBox {
        graph_box(uuid, "MarkerBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_MARKER_TRACK, TRACK_MARKERS])))),
            (MARKER_POSITION, FieldValue::Int32(position)),
            (MARKER_PLAYS, FieldValue::Int32(plays))
        ])
    }

    #[test]
    fn collects_markers_sorted_by_position() {
        let mut graph = BoxGraph::from_boxes(vec![
            timeline_box(true),
            marker_box(MARKER_B, 3840, 1),
            marker_box(MARKER_A, 0, 2)
        ]);
        let track = MarkerTrack::observe(&mut graph, TIMELINE);
        let markers = track.markers().clone();
        assert_eq!(markers, vec![
            Marker {uuid: MARKER_A, position: 0.0, plays: 2},
            Marker {uuid: MARKER_B, position: 3840.0, plays: 1}
        ]);
        assert!(track.enabled());
        assert!(!track.take_changed(), "the initial catch-up is not an edit (TS never raises #someMarkersChanged for it)");
    }

    #[test]
    fn rebinds_live_on_member_field_edits() {
        let mut graph = BoxGraph::from_boxes(vec![
            timeline_box(true),
            marker_box(MARKER_A, 0, 2),
            marker_box(MARKER_B, 3840, 1)
        ]);
        let track = MarkerTrack::observe(&mut graph, TIMELINE);
        let registry = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(MARKER_A, vec![MARKER_POSITION]),
            old: FieldValue::Int32(0),
            new: FieldValue::Int32(7680)
        }], &registry).unwrap();
        assert!(track.take_changed(), "a position edit raises the changed flag");
        assert_eq!(track.markers()[0].uuid, MARKER_B, "the list re-sorted around the moved marker");
        assert_eq!(track.markers()[1].position, 7680.0);
        graph.transaction(&[Update::Primitive {
            address: Address::of(MARKER_B, vec![MARKER_PLAYS]),
            old: FieldValue::Int32(1),
            new: FieldValue::Int32(0)
        }], &registry).unwrap();
        assert!(track.take_changed());
        assert_eq!(track.markers()[0].plays, 0, "a plays edit lands live");
    }

    #[test]
    fn rebinds_live_on_membership_changes() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(true), marker_box(MARKER_A, 0, 2)]);
        let track = MarkerTrack::observe(&mut graph, TIMELINE);
        let registry = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(MARKER_A, vec![1]),
            old: FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_MARKER_TRACK, TRACK_MARKERS]))),
            new: FieldValue::Pointer(None)
        }], &registry).unwrap();
        assert!(track.take_changed());
        assert!(track.markers().is_empty(), "a disconnected marker leaves the list");
    }

    #[test]
    fn the_enabled_flag_tracks_edits_without_raising_changed() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(true), marker_box(MARKER_A, 0, 2)]);
        let track = MarkerTrack::observe(&mut graph, TIMELINE);
        let registry = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(TIMELINE, vec![TIMELINE_MARKER_TRACK, TRACK_ENABLED]),
            old: FieldValue::Boolean(true),
            new: FieldValue::Boolean(false)
        }], &registry).unwrap();
        assert!(!track.enabled());
        assert!(!track.take_changed(), "TS never dispatches the track notifier for the enabled flag");
        assert_eq!(track.markers().len(), 1, "the marker list is independent of the flag");
    }
}
