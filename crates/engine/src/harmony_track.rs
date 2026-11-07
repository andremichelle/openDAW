//! The KEY and CHORD TRACKS: the engine port of the TS `KeyTrackAdapter` / `ChordTrackAdapter`. The
//! observer keeps owned position-sorted key and chord lists in sync with the box graph (hub members and
//! their field edits, the tracks' `enabled` flags), rebuilt inside subscription dispatch (off the render
//! path). Devices read the harmony at a pulse through the `host_harmony_at` import.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{Deferred, HubEvent, Propagation, SubscriptionId};

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
const TIMELINE_KEY_TRACK: u16 = 24; // TimelineBox.keyTrack = {events (1, hub), root (10), scale (11), enabled (20)}
const TIMELINE_CHORD_TRACK: u16 = 25; // TimelineBox.chordTrack = {events (1, hub), enabled (20)}
const TRACK_EVENTS: u16 = 1;
const TRACK_ENABLED: u16 = 20;
const STORAGE_ROOT: u16 = 10; // KeyTrack.root (Int32, 0..11), the key before the first event
const STORAGE_SCALE: u16 = 11; // KeyTrack.scale (Int32, 12-bit mask)
const EVENT_POSITION: u16 = 2; // KeyEventBox / ChordEventBox .position (Int32, ppqn)
const KEY_ROOT: u16 = 3; // KeyEventBox.root (Int32, 0..11)
const KEY_SCALE: u16 = 4; // KeyEventBox.scale (Int32, 12-bit mask)
const CHORD_DURATION: u16 = 3; // ChordEventBox.duration (Int32, ppqn)
const CHORD_DEGREE: u16 = 4; // ChordEventBox.degree (Int32, 1..7)
const CHORD_SHIFT: u16 = 5; // ChordEventBox.shift (Int32, -1..1)
const CHORD_SHAPE: u16 = 6; // ChordEventBox.shape (Int32, 12-bit mask, 0 = stacked from the scale)
const CHORD_NOTES: u16 = 7; // ChordEventBox.notes (Int32, 3..5)
const CHORD_INVERSION: u16 = 8; // ChordEventBox.inversion (Int32, 0..4)

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyEvent {
    pub position: f64,
    pub root: i32,
    pub bits: i32
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChordEvent {
    pub position: f64,
    pub duration: f64,
    pub degree: i32,
    pub shift: i32,
    pub shape: i32,
    pub notes: i32,
    pub inversion: i32
}

pub use abi::Harmony;

pub const DEFAULT_KEY: KeyEvent = KeyEvent {position: 0.0, root: 0, bits: math::harmony::MAJOR_BITS};

struct State {
    storage: KeyEvent,
    keys_enabled: bool,
    chords_enabled: bool,
    key_members: BTreeMap<Uuid, KeyEvent>,
    chord_members: BTreeMap<Uuid, ChordEvent>,
    subs: BTreeMap<Uuid, SubscriptionId>,
    keys: Vec<KeyEvent>,
    chords: Vec<ChordEvent>
}

impl State {
    fn new() -> Self {
        Self {
            storage: DEFAULT_KEY,
            keys_enabled: true,
            chords_enabled: true,
            key_members: BTreeMap::new(),
            chord_members: BTreeMap::new(),
            subs: BTreeMap::new(),
            keys: Vec::new(),
            chords: Vec::new()
        }
    }

    fn rebuild(&mut self) {
        self.keys = self.key_members.values().copied().collect();
        self.keys.sort_by(|left, right| left.position.total_cmp(&right.position));
        self.chords = self.chord_members.values().copied().collect();
        self.chords.sort_by(|left, right| left.position.total_cmp(&right.position));
    }

    fn key_at(&self, position: f64) -> KeyEvent {
        if !self.keys_enabled {
            return self.storage;
        }
        let index = self.keys.partition_point(|key| key.position <= position);
        if index == 0 {self.storage} else {self.keys[index - 1]}
    }

    fn harmony_at(&self, position: f64) -> Harmony {
        let key = self.key_at(position);
        let chord = if self.chords_enabled {
            let index = self.chords.partition_point(|chord| chord.position <= position);
            if index == 0 {
                None
            } else {
                let event = self.chords[index - 1];
                if position < event.position + event.duration {
                    let chord_key = self.key_at(event.position);
                    math::harmony::chord(chord_key.root, chord_key.bits, event.degree, event.shift, event.shape, event.notes, event.inversion)
                } else {
                    None
                }
            }
        } else {
            None
        };
        Harmony {root: key.root, bits: key.bits, chord}
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Key,
    Chord
}

/// A read-only handle on the lists for the `host_harmony_at` device import.
#[derive(Clone)]
pub struct HarmonyEvents(Rc<RefCell<State>>);

impl HarmonyEvents {
    pub fn harmony_at(&self, position: f64) -> Harmony {
        self.0.borrow().harmony_at(position)
    }
}

pub struct HarmonyTrack {
    state: Rc<RefCell<State>>,
    #[allow(dead_code)] // the timeline is a bind-once singleton; the subscriptions live for the session
    subscriptions: Vec<SubscriptionId>
}

impl HarmonyTrack {
    pub fn observe(graph: &mut BoxGraph, timeline: Uuid) -> Self {
        let state = Rc::new(RefCell::new(State::new()));
        let mut subscriptions = Vec::new();
        for field in [STORAGE_ROOT, STORAGE_SCALE] {
            let storage_state = state.clone();
            subscriptions.push(graph.catchup_and_subscribe(
                Address::of(timeline, vec![TIMELINE_KEY_TRACK, field]), move |value| {
                    if let Some(value) = value.as_int32() {
                        let mut state = storage_state.borrow_mut();
                        if field == STORAGE_ROOT {state.storage.root = value} else {state.storage.bits = value}
                    }
                }));
        }
        for (kind, track) in [(Kind::Key, TIMELINE_KEY_TRACK), (Kind::Chord, TIMELINE_CHORD_TRACK)] {
            let enabled_state = state.clone();
            subscriptions.push(graph.catchup_and_subscribe(
                Address::of(timeline, vec![track, TRACK_ENABLED]), move |value| {
                    if let Some(value) = value.as_bool() {
                        let mut state = enabled_state.borrow_mut();
                        match kind {
                            Kind::Key => state.keys_enabled = value,
                            Kind::Chord => state.chords_enabled = value
                        }
                    }
                }));
            let hub_state = state.clone();
            let hub_deferred = graph.deferred();
            subscriptions.push(graph.subscribe_pointer_hub(
                Address::of(timeline, vec![track, TRACK_EVENTS]),
                Box::new(move |graph, event| match event {
                    HubEvent::Added(source) => join(&hub_state, &hub_deferred, graph, kind, source.uuid),
                    HubEvent::Removed(source) => leave(&hub_state, &hub_deferred, source.uuid)
                })
            ));
        }
        graph.apply_deferred();
        Self {state, subscriptions}
    }

    pub fn handle(&self) -> HarmonyEvents {
        HarmonyEvents(self.state.clone())
    }

    pub fn harmony_at(&self, position: f64) -> Harmony {
        self.state.borrow().harmony_at(position)
    }
}

fn upsert(state: &Rc<RefCell<State>>, graph: &BoxGraph, kind: Kind, uuid: Uuid) {
    if graph.find_box(&uuid).is_none() {
        return;
    }
    let field = |key: u16| graph.field_value(&Address::of(uuid, vec![key])).and_then(FieldValue::as_int32);
    let mut state = state.borrow_mut();
    let position = field(EVENT_POSITION).unwrap_or(0) as f64;
    match kind {
        Kind::Key => {
            state.key_members.insert(uuid, KeyEvent {
                position,
                root: field(KEY_ROOT).unwrap_or(0),
                bits: field(KEY_SCALE).unwrap_or(math::harmony::MAJOR_BITS)
            });
        }
        Kind::Chord => {
            state.chord_members.insert(uuid, ChordEvent {
                position,
                duration: field(CHORD_DURATION).unwrap_or(0) as f64,
                degree: field(CHORD_DEGREE).unwrap_or(1),
                shift: field(CHORD_SHIFT).unwrap_or(0),
                shape: field(CHORD_SHAPE).unwrap_or(0),
                notes: field(CHORD_NOTES).unwrap_or(3),
                inversion: field(CHORD_INVERSION).unwrap_or(0)
            });
        }
    }
    state.rebuild();
}

fn join(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, kind: Kind, uuid: Uuid) {
    upsert(state, graph, kind, uuid);
    let field_state = state.clone();
    let field = deferred.subscribe_vertex(Propagation::Parent, Address::box_of(uuid),
        Box::new(move |graph, _update| upsert(&field_state, graph, kind, uuid)));
    state.borrow_mut().subs.insert(uuid, field);
}

fn leave(state: &Rc<RefCell<State>>, deferred: &Deferred, uuid: Uuid) {
    let mut state = state.borrow_mut();
    state.key_members.remove(&uuid);
    state.chord_members.remove(&uuid);
    state.rebuild();
    if let Some(id) = state.subs.remove(&uuid) {
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
    const KEY_A: Uuid = [2u8; 16];
    const KEY_B: Uuid = [3u8; 16];
    const CHORD_A: Uuid = [4u8; 16];
    const CHORD_B: Uuid = [5u8; 16];
    const BAR: i32 = 3840;
    const MAJOR_TRIAD: i32 = 0x91;
    const MINOR_TRIAD: i32 = 0x89;
    const WHOLE_TONE: i32 = 0b0101_0101_0101;
    const NATURAL_MINOR: i32 = 0x5AD;

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    fn track(enabled: bool) -> FieldValue {
        FieldValue::Object(BTreeMap::from([(TRACK_EVENTS, FieldValue::Hook), (TRACK_ENABLED, FieldValue::Boolean(enabled))]))
    }

    fn timeline_box() -> GraphBox {
        graph_box(TIMELINE, "TimelineBox", &[(TIMELINE_KEY_TRACK, key_track(0, math::harmony::MAJOR_BITS)), (TIMELINE_CHORD_TRACK, track(true))])
    }

    fn key_track(root: i32, bits: i32) -> FieldValue {
        FieldValue::Object(BTreeMap::from([
            (TRACK_EVENTS, FieldValue::Hook), (STORAGE_ROOT, FieldValue::Int32(root)),
            (STORAGE_SCALE, FieldValue::Int32(bits)), (TRACK_ENABLED, FieldValue::Boolean(true))
        ]))
    }

    fn key_box(uuid: Uuid, position: i32, root: i32, bits: i32) -> GraphBox {
        graph_box(uuid, "KeyEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_KEY_TRACK, TRACK_EVENTS])))),
            (EVENT_POSITION, FieldValue::Int32(position)),
            (KEY_ROOT, FieldValue::Int32(root)),
            (KEY_SCALE, FieldValue::Int32(bits))
        ])
    }

    fn chord_box(uuid: Uuid, position: i32, duration: i32, degree: i32) -> GraphBox {
        graph_box(uuid, "ChordEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_CHORD_TRACK, TRACK_EVENTS])))),
            (EVENT_POSITION, FieldValue::Int32(position)),
            (CHORD_DURATION, FieldValue::Int32(duration)),
            (CHORD_DEGREE, FieldValue::Int32(degree)),
            (CHORD_SHIFT, FieldValue::Int32(0)),
            (CHORD_SHAPE, FieldValue::Int32(0)),
            (CHORD_NOTES, FieldValue::Int32(3)),
            (CHORD_INVERSION, FieldValue::Int32(0))
        ])
    }

    fn primitive(graph: &mut BoxGraph, uuid: Uuid, path: Vec<u16>, old: FieldValue, new: FieldValue) {
        graph.transaction(&[Update::Primitive {address: Address::of(uuid, path), old, new}], &Registry::new()).unwrap();
    }

    #[test]
    fn defaults_to_c_major_without_events() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box()]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0), Harmony {root: 0, bits: math::harmony::MAJOR_BITS, chord: None});
        assert_eq!(harmony.harmony_at(100_000.0).root, 0);
    }

    #[test]
    fn the_stored_key_applies_before_the_first_event_and_when_disabled() {
        let mut graph = BoxGraph::from_boxes(vec![
            graph_box(TIMELINE, "TimelineBox", &[(TIMELINE_KEY_TRACK, key_track(9, NATURAL_MINOR)), (TIMELINE_CHORD_TRACK, track(true))]),
            key_box(KEY_A, BAR, 5, math::harmony::MAJOR_BITS),
            chord_box(CHORD_A, 0, BAR, 1)
        ]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0), Harmony {root: 9, bits: NATURAL_MINOR, chord: Some((9, MINOR_TRIAD))});
        assert_eq!(harmony.harmony_at(BAR as f64).root, 5);
        primitive(&mut graph, TIMELINE, vec![TIMELINE_KEY_TRACK, STORAGE_ROOT], FieldValue::Int32(9), FieldValue::Int32(2));
        assert_eq!(harmony.harmony_at(0.0).root, 2, "a stored key edit lands live");
        primitive(&mut graph, TIMELINE, vec![TIMELINE_KEY_TRACK, TRACK_ENABLED], FieldValue::Boolean(true), FieldValue::Boolean(false));
        assert_eq!(harmony.harmony_at(BAR as f64).root, 2, "a disabled key track plays the stored key");
    }

    #[test]
    fn key_events_apply_from_their_position() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(), key_box(KEY_B, 4 * BAR, 7, math::harmony::MAJOR_BITS), key_box(KEY_A, BAR, 5, math::harmony::MAJOR_BITS)]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0).root, 0, "before the first event the default key applies");
        assert_eq!(harmony.harmony_at(BAR as f64 - 1.0).root, 0);
        assert_eq!(harmony.harmony_at(BAR as f64).root, 5, "exactly on the boundary the new key applies");
        assert_eq!(harmony.harmony_at(4.0 * BAR as f64 - 1.0).root, 5);
        assert_eq!(harmony.harmony_at(4.0 * BAR as f64).root, 7);
    }

    #[test]
    fn chords_resolve_against_the_key_at_their_start() {
        let mut graph = BoxGraph::from_boxes(vec![
            timeline_box(),
            key_box(KEY_A, 2 * BAR, 5, math::harmony::MAJOR_BITS),
            chord_box(CHORD_A, 0, BAR, 5),
            chord_box(CHORD_B, BAR, 2 * BAR, 5)
        ]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0).chord, Some((7, MAJOR_TRIAD)), "degree 5 of C major is G");
        assert_eq!(harmony.harmony_at(BAR as f64 - 1.0).chord, Some((7, MAJOR_TRIAD)));
        assert_eq!(harmony.harmony_at(2.0 * BAR as f64 + 10.0).chord, Some((7, MAJOR_TRIAD)),
            "a chord spanning a key change keeps the key at its start");
        assert_eq!(harmony.harmony_at(2.0 * BAR as f64 + 10.0).root, 5, "while the key itself already changed");
        assert_eq!(harmony.harmony_at(3.0 * BAR as f64).chord, None, "no chord past the end");
    }

    #[test]
    fn edits_land_live() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(), chord_box(CHORD_A, 0, BAR, 1)]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0).chord, Some((0, MAJOR_TRIAD)));
        primitive(&mut graph, CHORD_A, vec![CHORD_DEGREE], FieldValue::Int32(1), FieldValue::Int32(6));
        assert_eq!(harmony.harmony_at(0.0).chord, Some((9, MINOR_TRIAD)), "degree 6 of C major is Am");
        primitive(&mut graph, CHORD_A, vec![CHORD_NOTES], FieldValue::Int32(3), FieldValue::Int32(4));
        primitive(&mut graph, CHORD_A, vec![CHORD_INVERSION], FieldValue::Int32(0), FieldValue::Int32(1));
        assert_eq!(harmony.harmony_at(0.0).chord, Some((9, (1 << 3) | (1 << 7) | (1 << 10) | (1 << 12))),
            "Am7 in 1st inversion: C E G A");
        primitive(&mut graph, TIMELINE, vec![TIMELINE_CHORD_TRACK, TRACK_ENABLED], FieldValue::Boolean(true), FieldValue::Boolean(false));
        assert_eq!(harmony.harmony_at(0.0).chord, None, "a disabled chord track yields no chord");
        primitive(&mut graph, TIMELINE, vec![TIMELINE_CHORD_TRACK, TRACK_ENABLED], FieldValue::Boolean(false), FieldValue::Boolean(true));
        primitive(&mut graph, CHORD_A, vec![1],
            FieldValue::Pointer(Some(Address::of(TIMELINE, vec![TIMELINE_CHORD_TRACK, TRACK_EVENTS]))), FieldValue::Pointer(None));
        assert_eq!(harmony.harmony_at(0.0).chord, None, "a disconnected chord leaves the list");
    }

    #[test]
    fn key_edits_and_disabling_land_live() {
        let mut graph = BoxGraph::from_boxes(vec![timeline_box(), key_box(KEY_A, 0, 2, math::harmony::MAJOR_BITS), chord_box(CHORD_A, 0, BAR, 1)]);
        let harmony = HarmonyTrack::observe(&mut graph, TIMELINE);
        assert_eq!(harmony.harmony_at(0.0).chord, Some((2, MAJOR_TRIAD)));
        primitive(&mut graph, KEY_A, vec![KEY_SCALE], FieldValue::Int32(math::harmony::MAJOR_BITS), FieldValue::Int32(WHOLE_TONE));
        assert_eq!(harmony.harmony_at(0.0), Harmony {root: 2, bits: WHOLE_TONE, chord: Some((2, 0x111))},
            "the chord follows a live scale edit: D augmented under D whole tone");
        primitive(&mut graph, TIMELINE, vec![TIMELINE_KEY_TRACK, TRACK_ENABLED], FieldValue::Boolean(true), FieldValue::Boolean(false));
        assert_eq!(harmony.harmony_at(0.0), Harmony {root: 0, bits: math::harmony::MAJOR_BITS, chord: Some((0, MAJOR_TRIAD))},
            "a disabled key track falls back to the stored key");
        primitive(&mut graph, KEY_A, vec![EVENT_POSITION], FieldValue::Int32(0), FieldValue::Int32(BAR));
        primitive(&mut graph, TIMELINE, vec![TIMELINE_KEY_TRACK, TRACK_ENABLED], FieldValue::Boolean(false), FieldValue::Boolean(true));
        assert_eq!(harmony.harmony_at(0.0).root, 0, "a moved key event re-sorts");
        assert_eq!(harmony.harmony_at(BAR as f64).root, 2);
    }
}
