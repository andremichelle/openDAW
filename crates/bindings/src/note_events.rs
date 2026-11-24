//! Read a `NoteEventBox` into a `NoteEvent` (the per-box read `NoteCollection` drives incrementally),
//! mirroring `value_events`. A note box carries position (key 10), duration (11), pitch (20),
//! velocity (21) and cent (24), its chance box (hub 30), its repeat box (hub 31) and its
//! group (pointer 32). `position` and `pitch` are mandatory schema fields, so a member missing them is a corrupt mirror and panics (naming box type, field and uuid for the panic buffer);
//! duration / velocity / cent fall back to schema defaults. Rejecting the transaction instead is not
//! reachable: this read fires from subscription dispatch (and the `observe` catch-up during rebind),
//! which runs AFTER `BoxGraph::transaction` has applied every update — the graph is committed and
//! observers return no `Result`, so there is no error path back to `Engine::apply_updates` from here.

use alloc::vec;
use alloc::vec::Vec;
use boxgraph::address::{uuid_to_string, Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use math::clamp;
use value::note::{NoteEvent, NoteGroup};

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
pub const COLLECTION_EVENTS: u16 = 1; // NoteEventCollectionBox.events (hub)
const NOTE_POSITION: u16 = 10; // Int32 pulses
const NOTE_DURATION: u16 = 11; // Int32 pulses
const NOTE_PITCH: u16 = 20; // Int32 (0..=127)
const NOTE_VELOCITY: u16 = 21; // Float32 (0..=1)
const NOTE_CENT: u16 = 24; // Float32 cents
pub const NOTE_RANDOM: u16 = 30; // hub, accepts one NoteEventChanceBox
pub const NOTE_SPLIT: u16 = 31; // hub, accepts one NoteEventRepeatBox
pub const NOTE_GROUP: u16 = 32; // pointer to a NoteEventGroupBox
const CHANCE_CHANCE: u16 = 2; // NoteEventChanceBox.chance, Int32 (0..=100)
const GROUP_CHANCE: u16 = 1; // NoteEventGroupBox.chance, Int32 (0..=100)
const GROUP_MODE: u16 = 2; // Int32, 0 = play all, 1 = play one
const REPEAT_COUNT: u16 = 2; // NoteEventRepeatBox.count, Int32 (>= 1)
const REPEAT_CURVE: u16 = 3; // Float32, the time-warp (0 = linear)
const REPEAT_LENGTH: u16 = 4; // Float32 (0..=1)
const REPEAT_FADE: u16 = 5; // Float32 (-1..=1)
const DEFAULT_DURATION: i32 = 240;
const DEFAULT_VELOCITY: f32 = 0.787_401_57; // 100/127, the schema default

/// A uuid folded into the 64-bit key the random decisions hash (FNV-1a).
pub fn fold_uuid(uuid: &Uuid) -> u64 {
    uuid.iter().fold(0xCBF2_9CE4_8422_2325u64, |hash, byte| (hash ^ *byte as u64).wrapping_mul(0x0100_0000_01B3))
}

fn int32(graph: &BoxGraph, uuid: Uuid, key: u16) -> Option<i32> {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(FieldValue::as_int32)
}

fn float32(graph: &BoxGraph, uuid: Uuid, key: u16) -> Option<f32> {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(FieldValue::as_float32)
}

/// The box pointing to the note hub `key` (the chance or repeat box), when it exists.
pub fn aux_box(graph: &BoxGraph, note_uuid: Uuid, key: u16) -> Option<Uuid> {
    graph.incoming(&Address::of(note_uuid, vec![key])).first().map(|source| source.uuid)
        .filter(|uuid| graph.find_box(uuid).is_some())
}

/// The group box the note points to, when it exists.
pub fn group_box(graph: &BoxGraph, note_uuid: Uuid) -> Option<Uuid> {
    graph.target_of(&Address::of(note_uuid, vec![NOTE_GROUP])).map(|target| target.uuid)
        .filter(|uuid| graph.find_box(uuid).is_some())
}

/// The member notes of a group, ordered by uuid (the order Play One picks from).
pub fn group_members(graph: &BoxGraph, group_uuid: Uuid) -> Vec<Uuid> {
    let mut members: Vec<Uuid> = graph.incoming(&Address::box_of(group_uuid)).iter()
        .map(|source| source.uuid)
        .collect();
    members.sort();
    members.dedup();
    members
}

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
    event.key = fold_uuid(&note_uuid);
    if let Some(chance) = aux_box(graph, note_uuid, NOTE_RANDOM) {
        event.chance = int32(graph, chance, CHANCE_CHANCE).unwrap_or(100) as f32;
    }
    if let Some(group) = group_box(graph, note_uuid) {
        let members = group_members(graph, group);
        event.group = Some(NoteGroup {
            key: fold_uuid(&group),
            chance: int32(graph, group, GROUP_CHANCE).unwrap_or(100) as f32,
            play_one: int32(graph, group, GROUP_MODE).unwrap_or(0) == 1,
            rank: members.iter().position(|member| *member == note_uuid).unwrap_or(0) as u32,
            size: members.len().max(1) as u32
        });
    }
    if let Some(repeat) = aux_box(graph, note_uuid, NOTE_SPLIT) {
        event.play_count = int32(graph, repeat, REPEAT_COUNT).unwrap_or(1).max(1);
        event.play_curve = float32(graph, repeat, REPEAT_CURVE).unwrap_or(0.0);
        event.repeat_length = float32(graph, repeat, REPEAT_LENGTH).unwrap_or(1.0);
        event.velocity_fade = float32(graph, repeat, REPEAT_FADE).unwrap_or(0.0);
    }
    event
}
