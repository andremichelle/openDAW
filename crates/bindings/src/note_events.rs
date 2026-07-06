//! Read a `NoteEventBox` into a `NoteEvent` (the per-box read `NoteCollection` drives incrementally),
//! mirroring `value_events`. A note box carries position (key 10), duration (11), pitch (20),
//! velocity (21) and cent (24). `position` and `pitch` are mandatory schema fields, so a member
//! missing them is a corrupt mirror and panics (naming box type, field and uuid for the panic buffer);
//! duration / velocity / cent fall back to schema defaults. Rejecting the transaction instead is not
//! reachable: this read fires from subscription dispatch (and the `observe` catch-up during rebind),
//! which runs AFTER `BoxGraph::transaction` has applied every update — the graph is committed and
//! observers return no `Result`, so there is no error path back to `Engine::apply_updates` from here.

use alloc::vec;
use boxgraph::address::{uuid_to_string, Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use math::clamp;
use value::note::NoteEvent;

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
pub const COLLECTION_EVENTS: u16 = 1; // NoteEventCollectionBox.events (hub)
const NOTE_POSITION: u16 = 10; // Int32 pulses
const NOTE_DURATION: u16 = 11; // Int32 pulses
const NOTE_PITCH: u16 = 20; // Int32 (0..=127)
const NOTE_VELOCITY: u16 = 21; // Float32 (0..=1)
const NOTE_PLAY_COUNT: u16 = 22; // Int32 (>= 1, the ratchet repeat count)
const NOTE_PLAY_CURVE: u16 = 23; // Float32 (the ratchet time-warp, 0 = linear)
const NOTE_CENT: u16 = 24; // Float32 cents
const NOTE_CHANCE: u16 = 25; // Int32 (0..=100, the play probability)
const DEFAULT_DURATION: i32 = 240;
const DEFAULT_VELOCITY: f32 = 0.787_401_57; // 100/127, the schema default

pub fn read_note_event(graph: &BoxGraph, note_uuid: Uuid) -> NoteEvent {
    let field = |key: u16| graph.field_value(&Address::of(note_uuid, vec![key]));
    let position = field(NOTE_POSITION).and_then(FieldValue::as_int32)
        .unwrap_or_else(|| panic!("NoteEventBox.position (Int32) missing @{}", uuid_to_string(&note_uuid))) as f64;
    let pitch = field(NOTE_PITCH).and_then(FieldValue::as_int32)
        .unwrap_or_else(|| panic!("NoteEventBox.pitch (Int32) missing @{}", uuid_to_string(&note_uuid)));
    let duration = field(NOTE_DURATION).and_then(FieldValue::as_int32).unwrap_or(DEFAULT_DURATION) as f64;
    let velocity = field(NOTE_VELOCITY).and_then(FieldValue::as_float32).unwrap_or(DEFAULT_VELOCITY);
    let cent = field(NOTE_CENT).and_then(FieldValue::as_float32).unwrap_or(0.0);
    let mut event = NoteEvent::new(position, duration, clamp(pitch, 0, 127) as u8, cent, velocity);
    event.chance = field(NOTE_CHANCE).and_then(FieldValue::as_int32).unwrap_or(100) as f32;
    event.play_count = field(NOTE_PLAY_COUNT).and_then(FieldValue::as_int32).unwrap_or(1);
    event.play_curve = field(NOTE_PLAY_CURVE).and_then(FieldValue::as_float32).unwrap_or(0.0);
    event
}
