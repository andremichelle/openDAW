//! The ZEITGEIST (groove / time-warp) MIDI-effect device: it warps note positions in time through the groove
//! its `groove` pointer (`[10]`) targets. To produce its output for `[from, to)` it pulls its upstream over
//! the UN-warped range `[unwarp(from), unwarp(to)]`, then maps each event's position through `warp`
//! (clamped back into `[from, to]`). The groove itself lives in the engine's groove registry (every groove
//! type, stacks included), the device follows its pointer through a slot from `abi::observe_groove`. Without
//! a groove the stream passes through unchanged. It works entirely in PULSE positions, so this device touches
//! no sample timing at all. While the transport loops, nothing after the loop end is read, and after a wrap nothing
//! before the loop start: every pass plays like a start at the loop start.
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
// block ends drift from the loop end by accumulated float error (1e-10 after a bar)
const WRAP_TOLERANCE: f64 = 1e-3;

/// The device's per-instance state (engine-allocated, set in `init`): the groove slot the engine keeps on the
/// `groove` pointer's target, the end of the last block and whether the transport wrapped since the last jump.
pub struct ZeitgeistState {
    slot: u32,
    last_to: f64,
    wrapped: bool
}

/// A wrap holds while the block lies inside the loop, a loop moved away from the playhead ends it.
pub fn still_wrapped(wrapped: bool, area: Option<(f64, f64)>, from: f64) -> bool {
    wrapped && area.is_some_and(|(loop_from, loop_to)| from >= loop_from && from < loop_to)
}

/// Limits the un-warped range `[u0, u1]` to the loop `area`: never past its end while the block lies before it,
/// never before its start after a wrap.
pub fn clip(u0: f64, u1: f64, area: Option<(f64, f64)>, from: f64, wrapped: bool) -> (f64, f64) {
    let Some((loop_from, loop_to)) = area else {return (u0, u1)};
    let limit = |position: f64| {
        let position = if from < loop_to && position > loop_to {loop_to} else {position};
        if wrapped && position < loop_from {loop_from} else {position}
    };
    (limit(u0), limit(u1))
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
    state.slot = abi::observe_groove(&GROOVE_POINTER);
    state.last_to = f64::NAN;
    state.wrapped = false;
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ZeitgeistState) };
    let slot = state.slot;
    let area = abi::loop_area();
    if flags & abi::BlockFlags::DISCONTINUOUS != 0 {
        state.wrapped = area.is_some_and(|(loop_from, loop_to)| from == loop_from && (state.last_to - loop_to).abs() < WRAP_TOLERANCE);
    }
    state.wrapped = still_wrapped(state.wrapped, area, from);
    state.last_to = to;
    let (pull_from, pull_to) = clip(abi::groove_unwarp(slot, from), abi::groove_unwarp(slot, to), area, from, state.wrapped);
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    // Pull the UN-warped range, so events that the groove pushes into [from, to) are captured.
    let pulled = abi::pull_events(pull_from, pull_to, flags, &mut scratch);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let released = if flags & abi::BlockFlags::DISCONTINUOUS != 0 {Some(pull_from)} else {None};
    process(|position| abi::groove_warp(slot, position), from, to, released, &scratch[..pulled], out) as u32
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
    fn without_a_loop_the_range_stays() {
        assert_eq!(clip(-240.0, 4000.0, None, 0.0, true), (-240.0, 4000.0));
    }

    #[test]
    fn nothing_after_the_loop_end_is_read_while_the_block_lies_before_it() {
        let area = Some((0.0, 3840.0));
        assert_eq!(clip(3800.0, 4100.0, area, 3500.0, false), (3800.0, 3840.0));
        assert_eq!(clip(3900.0, 4100.0, area, 3600.0, false), (3840.0, 3840.0));
        assert_eq!(clip(3900.0, 4100.0, area, 3840.0, false), (3900.0, 4100.0));
    }

    #[test]
    fn nothing_before_the_loop_start_is_read_after_a_wrap() {
        let area = Some((3840.0, 7680.0));
        assert_eq!(clip(3600.0, 3900.0, area, 3840.0, true), (3840.0, 3900.0));
        assert_eq!(clip(3600.0, 3700.0, area, 3840.0, true), (3840.0, 3840.0));
        assert_eq!(clip(3600.0, 3900.0, area, 3840.0, false), (3600.0, 3900.0));
    }

    #[test]
    fn a_loop_moved_away_from_the_playhead_ends_the_wrap() {
        // wrapped in bars 1 to 4, then the loop moved to bars 9 to 12 while the playhead is in bar 3
        assert!(!still_wrapped(true, Some((30720.0, 46080.0)), 8000.0));
        assert!(still_wrapped(true, Some((0.0, 15360.0)), 8000.0));
        assert!(!still_wrapped(true, None, 8000.0));
    }

    #[test]
    fn stops_at_the_output_capacity() {
        let input = [note_on(0.0), note_on(240.0), note_on(480.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position, 0.0, 960.0, None, &input, &mut out), 2);
    }
}
