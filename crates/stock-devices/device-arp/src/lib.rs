//! A dummy ARPEGGIATOR MIDI-effect device: the strong proof of the stateful, NON-one-to-one event pull
//! (Route A). Modeled on the TS `ArpeggioDeviceProcessor` (a held-note stack plus a span retainer that
//! schedules note-offs), reduced to the essentials. It is a PULL SOURCE wired before an instrument
//! (instrument <- arp <- sequencer): the host calls `process_events(from, to, flags, state, out, max)`
//! when the instrument pulls, and the arp pulls its OWN upstream, updates its held-note stack, and emits
//! rate-stepped note-ons (one held note at a time, cycling) with their note-offs scheduled across later
//! blocks. So a few HELD notes become a long STREAM — not one-to-one — and the held stack must PERSIST
//! across blocks where no input arrives, which is exactly what the per-instance state block is for.
//!
//! Timing is musical: it places each step on a 1/16 grid via the `host_pulse_to_offset` import. On a
//! transport jump (DISCONTINUOUS) it releases everything it holds, mirroring the TS `releaseAll`.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const SIXTEENTH: f64 = 240.0; // step rate in pulses: PPQN(960) / 4
const GATE: f64 = 0.5; // step note length as a fraction of the step (staccato, so the arp is distinct)
const MAX_HELD: usize = 16; // simultaneously held input notes (chord size)
const MAX_ACTIVE: usize = 64; // emitted notes awaiting their scheduled note-off
const EMIT_MAX: usize = 64; // events emitted in one block (note-offs + note-ons)
const PULL_SCRATCH: usize = 256; // on-stack buffer the upstream pull writes into

#[derive(Clone, Copy)]
struct Held {
    id: u32,
    pitch: u32,
    velocity: f32
}

#[derive(Clone, Copy)]
struct Active {
    id: u32,
    pitch: u32,
    end_pulse: f64
}

/// The arp's per-instance state, interpreted from the engine-allocated (zeroed) block: the stack of
/// currently held input notes, the emitted notes awaiting their note-off, a cycling step index, and an id
/// generator. Valid when zeroed (all counts 0). Persists across pulls, so a chord held over many blocks
/// keeps arpeggiating even in blocks that carry no new input.
pub struct ArpState {
    held: [Held; MAX_HELD],
    active: [Active; MAX_ACTIVE],
    held_count: u32,
    active_count: u32,
    step: u32,
    next_id: u32
}

/// Update the held-note stack from one block's input events: a note-on pushes, a note-off removes by id.
pub fn ingest(state: &mut ArpState, input: &[EventRecord]) {
    for record in input {
        if record.kind == EVENT_NOTE_ON {
            if (state.held_count as usize) < MAX_HELD {
                state.held[state.held_count as usize] = Held {id: record.id, pitch: record.pitch, velocity: record.velocity};
                state.held_count += 1;
            }
        } else {
            remove_held(state, record.id);
        }
    }
}

fn remove_held(state: &mut ArpState, id: u32) {
    let mut index = 0;
    while index < state.held_count as usize {
        if state.held[index].id == id {
            state.held[index] = state.held[state.held_count as usize - 1];
            state.held_count -= 1;
            return;
        }
        index += 1;
    }
}

fn lifecycle_rank(record: &EventRecord) -> u8 {
    if record.kind == EVENT_NOTE_OFF { 0 } else { 1 }
}

/// Smallest multiple of `SIXTEENTH` that is `>= from` (the first grid step in the range). Avoids `f64::ceil`
/// (not in `core`) via integer truncation; pulse positions are non-negative.
fn first_grid(from: f64) -> f64 {
    let ratio = from / SIXTEENTH;
    let floor = ratio as i64 as f64;
    let steps = if floor < ratio { floor + 1.0 } else { floor };
    steps * SIXTEENTH
}

/// Produce one block's events for `[from, to)`: first release the note-offs that come due (all of them on a
/// DISCONTINUOUS transport jump, else those whose scheduled end falls in this block), then emit a note-on
/// for each rate step, cycling through the held stack. Events carry their PULSE `position` (the downstream
/// consumer resolves sample offsets), so the output is position-sorted (note-off before note-on at an equal
/// position). Returns the count written.
pub fn step(state: &mut ArpState, from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> usize {
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
    let mut emitted = [blank; EMIT_MAX];
    let mut count = 0;
    let discontinuous = flags & abi::BlockFlags::DISCONTINUOUS != 0;
    let mut index = 0;
    while index < state.active_count as usize {
        let active = state.active[index];
        if discontinuous || active.end_pulse < to {
            let end = if discontinuous || active.end_pulse < from { from } else { active.end_pulse };
            if count < EMIT_MAX {
                emitted[count] = EventRecord {position: end, offset: 0, kind: EVENT_NOTE_OFF, id: active.id, pitch: active.pitch, velocity: 0.0, cent: 0.0};
                count += 1;
            }
            state.active[index] = state.active[state.active_count as usize - 1];
            state.active_count -= 1;
        } else {
            index += 1;
        }
    }
    if state.held_count > 0 {
        let mut pulse = first_grid(from);
        while pulse < to {
            if count < EMIT_MAX && (state.active_count as usize) < MAX_ACTIVE {
                let held = state.held[(state.step as usize) % state.held_count as usize];
                let id = state.next_id;
                state.next_id = state.next_id.wrapping_add(1);
                emitted[count] = EventRecord {position: pulse, offset: 0, kind: EVENT_NOTE_ON, id, pitch: held.pitch, velocity: held.velocity, cent: 0.0};
                count += 1;
                state.active[state.active_count as usize] = Active {id, pitch: held.pitch, end_pulse: pulse + SIXTEENTH * GATE};
                state.active_count += 1;
            }
            state.step = state.step.wrapping_add(1);
            pulse += SIXTEENTH;
        }
    }
    emitted[..count].sort_unstable_by(|a, b| {
        a.position.partial_cmp(&b.position).unwrap_or(core::cmp::Ordering::Equal).then(lifecycle_rank(a).cmp(&lifecycle_rank(b)))
    });
    let written = count.min(out.len());
    out[..written].copy_from_slice(&emitted[..written]);
    written
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's held-note / scheduling state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ArpState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    let pulled = abi::pull_events(from, to, flags, &mut scratch);
    ingest(state, &scratch[..pulled]);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    step(state, from, to, flags, out) as u32
}
