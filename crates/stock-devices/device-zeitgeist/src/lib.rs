//! The ZEITGEIST (groove / time-warp) MIDI-effect device: it warps note positions in time through the groove
//! its `groove` pointer (`[10]`) targets. To produce its output for `[from, to)` it pulls its upstream over
//! the UN-warped range `[unwarp(from), unwarp(to)]`, then maps each event's position through `warp`
//! (clamped back into `[from, to]`). The groove itself lives in the engine's groove registry (every groove
//! type, stacks included), the device follows its pointer through a slot from `abi::observe_groove`. Without
//! a groove the stream passes through unchanged. It works entirely in PULSE positions, so this device touches
//! no sample timing at all. While the transport loops, the un-warped range is folded into the loop area (a part
//! beyond the loop end is read from its start, after a wrap a part before the loop start from its end), so the
//! pulled timeline wraps on its own and is marked discontinuous exactly where it jumps.
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
/// `groove` pointer's target, the loop passes since the last jump, the pass the pulled timeline is in, the
/// end of the last block and where the last pull ended (NaN after a jump).
pub struct ZeitgeistState {
    slot: u32,
    pass: i64,
    pulled_pass: i64,
    last_to: f64,
    pulled_to: f64
}

fn length_of(area: Option<(f64, f64)>) -> f64 {
    area.map_or(0.0, |(loop_from, loop_to)| loop_to - loop_from)
}

fn floor_to_int(value: f64) -> i64 {
    let truncated = value as i64;
    if (truncated as f64) > value { truncated - 1 } else { truncated }
}

/// Splits the un-warped range `[u0, u1)` into pieces `(pull_from, pull_to, passes)` read inside the loop area and
/// moved by `passes` loop lengths. Beyond the loop end only while the block lies before it (the transport wraps
/// there), before the loop start at most `wraps` passes back (further back lies what played before the loop).
/// At least one piece, so an empty range still pulls.
pub fn fold<F: FnMut(f64, f64, i64)>(u0: f64, u1: f64, area: Option<(f64, f64)>, from: f64, wraps: i64, mut piece: F) {
    let Some((loop_from, loop_to)) = area else {
        piece(u0, u1, 0);
        return
    };
    let length = loop_to - loop_from;
    let ahead = from < loop_to;
    let mut position = u0;
    loop {
        let passes = if ahead && position >= loop_to {
            floor_to_int((position - loop_from) / length)
        } else if wraps > 0 && position < loop_from {
            floor_to_int((position - loop_from) / length).max(-wraps)
        } else {0};
        let end = if passes != 0 {
            loop_from + (passes + 1) as f64 * length
        } else if ahead && position < loop_to {loop_to} else {u1};
        let end = if end < u1 {end} else {u1};
        let shift = passes as f64 * length;
        piece(position - shift, end - shift, passes);
        position = end;
        if position >= u1 {break}
    }
}

/// The pure block transform (host-free, so native tests drive it): warp each input record's position and
/// clamp it into `[from, to]` (TS `clamp(groove.warp(event.position), from, to)`). Returns the count written.
pub fn process<W: Fn(f64) -> f64>(warp: W, from: f64, to: f64, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    let mut count = 0;
    for record in input {
        if count >= out.len() {
            break;
        }
        let warped = warp(record.position);
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
    state.pass = 0;
    state.pulled_pass = 0;
    state.last_to = f64::NAN;
    state.pulled_to = f64::NAN;
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ZeitgeistState) };
    let slot = state.slot;
    let area = abi::loop_area();
    if flags & abi::BlockFlags::DISCONTINUOUS != 0 {
        if area.is_some_and(|(loop_from, loop_to)| from == loop_from && (state.last_to - loop_to).abs() < WRAP_TOLERANCE) {
            state.pass += 1;
            state.pulled_to -= length_of(area);
        } else {
            state.pass = 0;
            state.pulled_pass = i64::MIN;
            state.pulled_to = f64::NAN;
        }
    }
    if flags & abi::BlockFlags::TRANSPORTING == 0 {
        state.pulled_to = f64::NAN;
    }
    state.last_to = to;
    let length = length_of(area);
    // The pull continues where the last one ended, so a groove whose cells do not fit the loop loses no note at the wrap.
    let unwarped_to = abi::groove_unwarp(slot, to);
    let (pull_from, pull_to) = if state.pulled_to.is_nan() {
        (abi::groove_unwarp(slot, from), unwarped_to)
    } else {
        (state.pulled_to, if unwarped_to > state.pulled_to {unwarped_to} else {state.pulled_to})
    };
    state.pulled_to = pull_to;
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    let mut pulled = 0;
    // Pull the UN-warped range, so events that the groove pushes into [from, to) are captured.
    fold(pull_from, pull_to, area, from, state.pass, |pull_from, pull_to, passes| {
        let pulled_pass = state.pass + passes;
        let piece_flags = if pulled_pass != state.pulled_pass {
            flags | abi::BlockFlags::DISCONTINUOUS
        } else {
            flags & !abi::BlockFlags::DISCONTINUOUS
        };
        state.pulled_pass = pulled_pass;
        let count = abi::pull_events(pull_from, pull_to, piece_flags, &mut scratch[pulled..]);
        let shift = passes as f64 * length;
        for record in &mut scratch[pulled..pulled + count] {
            record.position += shift;
        }
        pulled += count;
    });
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    process(|position| abi::groove_warp(slot, position), from, to, &scratch[..pulled], out) as u32
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
        let written = process(|position| position + 100.0, 0.0, 800.0, &input, &mut out);
        assert_eq!(written, 4);
        let positions: Vec<f64> = out[..written].iter().map(|record| record.position).collect();
        assert_eq!(positions, vec![100.0, 340.0, 580.0, 800.0]);
    }

    #[test]
    fn the_identity_passes_the_stream_through() {
        let input = [note_on(0.0), note_on(240.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position, 0.0, 480.0, &input, &mut out), 2);
        assert_eq!(out[1].position, 240.0);
    }

    fn pieces(u0: f64, u1: f64, area: Option<(f64, f64)>, from: f64, wraps: i64) -> Vec<(f64, f64, i64)> {
        let mut pieces = Vec::new();
        fold(u0, u1, area, from, wraps, |pull_from, pull_to, passes| pieces.push((pull_from, pull_to, passes)));
        pieces
    }

    #[test]
    fn without_a_loop_the_range_is_one_piece() {
        assert_eq!(pieces(-240.0, 100.0, None, 0.0, 0), vec![(-240.0, 100.0, 0)]);
        assert_eq!(pieces(50.0, 50.0, None, 50.0, 0), vec![(50.0, 50.0, 0)]);
    }

    #[test]
    fn beyond_the_loop_end_reads_from_the_loop_start() {
        let area = Some((0.0, 3840.0));
        assert_eq!(pieces(3800.0, 4320.0, area, 3500.0, 0), vec![(3800.0, 3840.0, 0), (0.0, 480.0, 1)]);
        assert_eq!(pieces(3900.0, 4000.0, area, 3500.0, 0), vec![(60.0, 160.0, 1)]);
        assert_eq!(pieces(3800.0, 3840.0, area, 3500.0, 0), vec![(3800.0, 3840.0, 0)]);
    }

    #[test]
    fn behind_the_loop_start_reads_from_the_loop_end_only_after_a_wrap() {
        let area = Some((3840.0, 7680.0));
        assert_eq!(pieces(3600.0, 3700.0, area, 3840.0, 1), vec![(7440.0, 7540.0, -1)]);
        assert_eq!(pieces(3600.0, 3900.0, area, 3840.0, 1), vec![(7440.0, 7680.0, -1), (3840.0, 3900.0, 0)]);
        assert_eq!(pieces(3600.0, 3900.0, area, 3840.0, 0), vec![(3600.0, 3900.0, 0)]);
    }

    #[test]
    fn after_the_loop_end_nothing_folds() {
        assert_eq!(pieces(7700.0, 8000.0, Some((3840.0, 7680.0)), 7680.0, 1), vec![(7700.0, 8000.0, 0)]);
    }

    #[test]
    fn a_loop_shorter_than_the_range_folds_more_than_once() {
        let area = Some((0.0, 240.0));
        assert_eq!(pieces(200.0, 700.0, area, 100.0, 0),
            vec![(200.0, 240.0, 0), (0.0, 240.0, 1), (0.0, 220.0, 2)]);
        assert_eq!(pieces(-500.0, 10.0, area, 0.0, 3),
            vec![(220.0, 240.0, -3), (0.0, 240.0, -2), (0.0, 240.0, -1), (0.0, 10.0, 0)]);
        assert_eq!(pieces(-500.0, 10.0, area, 0.0, 1), vec![(-260.0, 240.0, -1), (0.0, 10.0, 0)]);
    }

    #[test]
    fn stops_at_the_output_capacity() {
        let input = [note_on(0.0), note_on(240.0), note_on(480.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 2];
        assert_eq!(process(|position| position, 0.0, 960.0, &input, &mut out), 2);
    }
}
