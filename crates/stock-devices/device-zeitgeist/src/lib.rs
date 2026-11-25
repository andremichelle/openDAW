//! The ZEITGEIST (groove / time-warp) MIDI-effect device: it warps note positions in time through the groove
//! its `groove` pointer (`[10]`) targets. To produce its output for `[from, to)` it pulls its upstream over
//! the UN-warped range `[unwarp(from), unwarp(to)]`, then maps each event's position through `warp`
//! (clamped back into `[from, to]`). The groove itself lives in the engine's groove registry (every groove
//! type, stacks included), the device follows its pointer through a slot from `abi::observe_groove`. Without
//! a groove the stream passes through unchanged. It works entirely in PULSE positions, so this device touches
//! no sample timing at all.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `init(...)`, `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::EventRecord;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

// WASM CONTRACT: the groove pointer key on `ZeitgeistDeviceBox`
const GROOVE_POINTER: [u16; 1] = [10];
const PULL_SCRATCH: usize = 256;

/// The device's per-instance state (engine-allocated, set in `init`): its groove pointer, followed block by block.
pub struct ZeitgeistState {
    groove: abi::GrooveFollower
}

/// The pure block transform (host-free, so native tests drive it): warp each input record's position and
/// clamp it into `[from, to]` (TS `clamp(groove.warp(event.position), from, to)`). A note-off at `released` (the
/// start of a pull after a jump, where the upstream releases its held notes) sounds at `from`. Returns the count written.
pub fn process<W: Fn(f64) -> f64>(warp: W, from: f64, to: f64, released: Option<f64>, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    let mut count = 0;
    for record in input {
        if count >= out.len() {
            break;
        }
        let warped = if record.kind == abi::EVENT_NOTE_OFF && released == Some(record.position) {from} else {warp(record.position)};
        let position = if warped < from { from } else if warped > to { to } else { warped };
        let mut shifted = *record;
        shifted.position = position;
        out[count] = shifted;
        count += 1;
    }
    count
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ZeitgeistState>() as u32
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, _sample_rate: f32) {
    let state = unsafe { &mut *(state_ptr as *mut ZeitgeistState) };
    state.groove = abi::GrooveFollower::observe(&GROOVE_POINTER);
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ZeitgeistState) };
    let (pull_from, pull_to) = state.groove.straight(from, to, flags & abi::BlockFlags::DISCONTINUOUS != 0);
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    // Pull the UN-warped range, so events that the groove pushes into [from, to) are captured.
    let pulled = abi::pull_events(pull_from, pull_to, flags, &mut scratch);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let released = if flags & abi::BlockFlags::DISCONTINUOUS != 0 {Some(pull_from)} else {None};
    let groove = state.groove;
    process(|position| groove.warp(position), from, to, released, &scratch[..pulled], out) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_on(position: f64) -> EventRecord {
        EventRecord {position, offset: 0, kind: abi::EVENT_NOTE_ON, id: 1, pitch: 60, velocity: 0.8, cent: 0.0, duration: 240.0}
    }

    #[test]
    fn warps_every_event_and_clamps_into_the_block() {
        let input = [note_on(0.0), note_on(240.0), note_on(480.0), note_on(720.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 8];
        let written = process(|position| position + 100.0, 0.0, 800.0, None, &input, &mut out);
        assert_eq!(written, 4);
        let positions: Vec<f64> = out[..written].iter().map(|record| record.position).collect();
        assert_eq!(positions, vec![100.0, 340.0, 580.0, 800.0]);
    }

    #[test]
    fn the_identity_passes_the_stream_through() {
        let input = [note_on(0.0), note_on(240.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position, 0.0, 480.0, None, &input, &mut out), 2);
        assert_eq!(out[1].position, 240.0);
    }

    #[test]
    fn a_note_released_by_a_jump_ends_at_the_block_start() {
        let off = EventRecord {position: 3840.0, offset: 0, kind: abi::EVENT_NOTE_OFF, id: 1, pitch: 60, velocity: 0.0, cent: 0.0, duration: 0.0};
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position + 479.0, 3840.0, 3845.12, Some(3840.0), &[off, note_on(3840.0)], &mut out), 2);
        assert_eq!(out[0].position, 3840.0);
        assert_eq!(out[1].position, 3845.12);
    }

    #[test]
    fn stops_at_the_output_capacity() {
        let input = [note_on(0.0), note_on(240.0), note_on(480.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position, 0.0, 960.0, None, &input, &mut out), 2);
    }
}
