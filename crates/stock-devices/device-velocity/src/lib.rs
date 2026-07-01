//! The Velocity MIDI-EFFECT device, a faithful port of the TS `VelocityDeviceProcessor` +
//! `VelocityDeviceBoxAdapter.computeVelocity`. It rewrites each note-on's velocity: pulled toward a magnet
//! target, jittered by a per-note seeded random, offset, then blended against the original by a mix. Note-offs
//! pass through untouched. A pull source in the event chain (no audio).
//!
//! Parameters (`VelocityDeviceBox`): magnet-position `[10]` (unipolar), magnet-strength `[11]` (unipolar),
//! random-seed `[12]` (linear-integer 0..0xFFFF), random-amount `[13]` (unipolar), offset `[14]` (bipolar),
//! mix `[15]` (unipolar). The random is reseeded per note from `random-seed + note position`, so the jitter is
//! deterministic and position-locked, exactly like the TS.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `process_events(...)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON};
use math::clamp;
use math::random::Mulberry32;
use math::value_mapping::{Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAGNET_POSITION_FIELD: [u16; 1] = [10];
const MAGNET_STRENGTH_FIELD: [u16; 1] = [11];
const RANDOM_SEED_FIELD: [u16; 1] = [12];
const RANDOM_AMOUNT_FIELD: [u16; 1] = [13];
const OFFSET_FIELD: [u16; 1] = [14];
const MIX_FIELD: [u16; 1] = [15];

const UNIPOLAR: Linear = Linear::unipolar();
const BIPOLAR: Linear = Linear::bipolar();
const SEED_MAPPING: LinearInteger = LinearInteger {min: 0, max: 0xFFFF};

/// The velocity transform's per-instance state (engine-allocated, zeroed): the current parameter values, the
/// per-note reseeded PRNG, and the parameter ids. Valid when zeroed (all-zero params = silence-ish until the
/// engine pushes the defaults).
pub struct VelocityState {
    magnet_position: f32,
    magnet_strength: f32,
    random_seed: i32,
    random_amount: f32,
    offset: f32,
    mix: f32,
    random: Mulberry32,
    magnet_position_id: u32,
    magnet_strength_id: u32,
    random_seed_id: u32,
    random_amount_id: u32,
    offset_id: u32,
    mix_id: u32
}

/// The transform, plugged into the SDK's `MidiEffect` template ([`abi::render_midi_effect`]).
pub struct Velocity;

impl Velocity {
    /// Rewrite one velocity for a note at `position` (mirrors `computeVelocity`): reseed from `random-seed +
    /// position`, pull the original toward the magnet, add scaled random + offset, clamp, and mix against dry.
    fn compute_velocity(state: &mut VelocityState, position: f64, original: f32) -> f32 {
        let seed = (state.random_seed as f64 + position) as i64 as u32;
        state.random.set_seed(seed);
        let magnet = original + (state.magnet_position - original) * state.magnet_strength;
        let random = (state.random.uniform() * 2.0 - 1.0) * state.random_amount;
        let delta = state.offset;
        let wet = state.mix;
        original * (1.0 - wet) + clamp(magnet + random + delta, 0.0, 1.0) * wet
    }
}

impl MidiEffect for Velocity {
    type State = VelocityState;

    fn init(state: &mut VelocityState, _sample_rate: f32) {
        state.magnet_position_id = abi::bind_parameter(&MAGNET_POSITION_FIELD);
        state.magnet_strength_id = abi::bind_parameter(&MAGNET_STRENGTH_FIELD);
        state.random_seed_id = abi::bind_parameter(&RANDOM_SEED_FIELD);
        state.random_amount_id = abi::bind_parameter(&RANDOM_AMOUNT_FIELD);
        state.offset_id = abi::bind_parameter(&OFFSET_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
    }

    fn parameter_changed(state: &mut VelocityState, id: u32, value: ParamValue) {
        if id == state.magnet_position_id {
            state.magnet_position = abi::float_value(value, &UNIPOLAR);
        } else if id == state.magnet_strength_id {
            state.magnet_strength = abi::float_value(value, &UNIPOLAR);
        } else if id == state.random_seed_id {
            state.random_seed = abi::int_value(value, &SEED_MAPPING);
        } else if id == state.random_amount_id {
            state.random_amount = abi::float_value(value, &UNIPOLAR);
        } else if id == state.offset_id {
            state.offset = abi::float_value(value, &BIPOLAR);
        } else if id == state.mix_id {
            state.mix = abi::float_value(value, &UNIPOLAR);
        }
    }

    fn transform(state: &mut VelocityState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            let mut event = *record;
            if record.kind == EVENT_NOTE_ON {
                event.velocity = Velocity::compute_velocity(state, record.position, record.velocity);
            }
            output[count] = event;
            count += 1;
        }
        count
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<VelocityState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<Velocity>(from, to, flags, state_ptr, out_ptr, max)
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Velocity as MidiEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Velocity as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    use super::{Velocity, VelocityState};
    use abi::{EventRecord, MidiEffect, EVENT_NOTE_OFF, EVENT_NOTE_ON};

    fn state() -> VelocityState {
        let mut state: VelocityState = unsafe { core::mem::zeroed() };
        // default-ish: magnet at 0.5, no strength, some seed, no random, no offset, full wet
        state.magnet_position = 0.5;
        state.magnet_strength = 0.0;
        state.random_seed = 0x800;
        state.random_amount = 0.0;
        state.offset = 0.0;
        state.mix = 1.0;
        state
    }

    fn note(kind: u32, position: f64, velocity: f32) -> EventRecord {
        EventRecord {position, offset: 0, kind, id: 1, pitch: 60, velocity, cent: 0.0, duration: 0.0}
    }

    #[test]
    fn no_strength_no_random_no_offset_passes_velocity_through() {
        let mut state = state();
        let input = [note(EVENT_NOTE_ON, 0.0, 0.8)];
        let mut output = [note(EVENT_NOTE_ON, 0.0, 0.0)];
        assert_eq!(Velocity::transform(&mut state, &input, &mut output), 1);
        assert!((output[0].velocity - 0.8).abs() < 1e-6, "full wet but identity transform");
    }

    #[test]
    fn full_magnet_strength_snaps_to_the_magnet_position() {
        let mut state = state();
        state.magnet_strength = 1.0; // pull fully to magnet_position (0.5)
        let input = [note(EVENT_NOTE_ON, 0.0, 0.9)];
        let mut output = [note(EVENT_NOTE_ON, 0.0, 0.0)];
        Velocity::transform(&mut state, &input, &mut output);
        assert!((output[0].velocity - 0.5).abs() < 1e-6, "snaps to the magnet target");
    }

    #[test]
    fn offset_shifts_and_clamps_the_velocity() {
        let mut state = state();
        state.offset = 0.5; // magnet(=orig here, strength 0) + offset, clamped
        let input = [note(EVENT_NOTE_ON, 0.0, 0.9)];
        let mut output = [note(EVENT_NOTE_ON, 0.0, 0.0)];
        Velocity::transform(&mut state, &input, &mut output);
        assert_eq!(output[0].velocity, 1.0, "0.9 + 0.5 clamps to 1.0");
    }

    #[test]
    fn note_off_passes_through_unchanged() {
        let mut state = state();
        state.offset = 0.5;
        let input = [note(EVENT_NOTE_OFF, 0.0, 0.3)];
        let mut output = [note(EVENT_NOTE_OFF, 0.0, 0.0)];
        Velocity::transform(&mut state, &input, &mut output);
        assert_eq!(output[0].velocity, 0.3, "note-off velocity is untouched");
    }

    #[test]
    fn random_amount_jitters_but_stays_bounded_and_deterministic() {
        let mut state = state();
        state.random_amount = 0.5;
        let input = [note(EVENT_NOTE_ON, 100.0, 0.5)];
        let mut output = [note(EVENT_NOTE_ON, 0.0, 0.0)];
        Velocity::transform(&mut state, &input, &mut output);
        let first = output[0].velocity;
        assert!((0.0..=1.0).contains(&first), "stays in range");
        // Same note position + seed -> identical result.
        Velocity::transform(&mut state, &input, &mut output);
        assert_eq!(output[0].velocity, first, "deterministic per position");
    }
}
