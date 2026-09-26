//! `device-tubular`, the six-operator FM instrument (see `plans/tubular.md`): a Rust port of Dexed's msfa
//! engine (Google, Apache-2.0) with Dexed's host layer and output stage (Pascal Gauthier, GPL-3.0). The
//! 156 patch / output parameters arrive as bound parameters and land in the 155-byte DX7 voice (edits
//! refresh sounding voices on the next frame, as in Dexed); rendering runs in Dexed's 64-sample frames
//! behind a small ring, so note events snap to the frame grid exactly like the plugin.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed`, `field_changed`, `map_parameter`, `reset`. Operator kernel: Dexed's Mark I by
//! default, msfa's Modern on request (plain `engine` field).

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, Block, EventRecord, FieldValue, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use math::value_mapping::{Linear, LinearInteger, Values};

mod env;
pub mod fm;
mod fx;
#[cfg(not(target_family = "wasm"))]
pub mod harness;
mod lfo;
mod mki;
mod note;
pub mod params;
pub mod patch;
mod pitchenv;
mod porta;
pub mod synth;
mod tables;
use params::Target;
use synth::Synth;

pub const LG_N: u32 = 6;
pub const N: usize = 1 << LG_N;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const UNIPOLAR: Linear = Linear::unipolar();
const TUNE_MAPPING: Linear = Linear {min: -100.0, max: 100.0};
const VOICING_MODE_VALUES: [i32; 2] = [0, 1];

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block.
pub struct TubularState {
    pub synth: Synth,
    frame: [f32; N],
    frame_pos: usize,
    ids: [u32; params::COUNT],
    load_id: u32,
    load_count: i32,
    engine_id: u32,
    base_frequency: f32
}

const VOICE_LOAD_FIELD: [u16; 1] = [50];
const ENGINE_FIELD: [u16; 1] = [51];

/// openDAW's per-note pitch offset in Q24-per-octave: the event's cents plus the A4 base tuning.
fn note_offset(cent: f32, base_frequency: f32) -> i32 {
    if cent == 0.0 && base_frequency == 440.0 {
        return 0;
    }
    let octaves = cent as f64 / 1200.0 + libm::log2(base_frequency as f64 / 440.0);
    (octaves * (1u32 << 24) as f64) as i32
}

fn apply(state: &mut TubularState, index: usize, value: ParamValue) {
    let spec = params::spec(index);
    match spec.target {
        Target::Cutoff => state.synth.fx.ui_cutoff = float_value(value, &UNIPOLAR),
        Target::Resonance => state.synth.fx.ui_reso = float_value(value, &UNIPOLAR),
        Target::Output => state.synth.fx.ui_gain = float_value(value, &UNIPOLAR),
        Target::Mono => {
            let mono = int_value(value, &Values::new(&VOICING_MODE_VALUES)) == 0;
            if mono != state.synth.mono_mode() {
                state.synth.set_mono_mode(mono);
            }
        }
        Target::Tune => {
            let cents = float_value(value, &TUNE_MAPPING);
            state.synth.controllers.master_tune = (cents as f64 / 100.0 * note::LOGFREQ_STEP as f64) as i32;
        }
        Target::Byte(offset) => state.synth.set_byte(offset, int_value(value, &LinearInteger {min: 0, max: spec.max}) as u8),
        Target::OpSwitch(op) => state.synth.controllers.op_switch[op] = int_value(value, &LinearInteger {min: 0, max: 1}) != 0
    }
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct Tubular;

impl Instrument for Tubular {
    type State = TubularState;

    fn init(state: &mut TubularState, sample_rate: f32) {
        state.synth.init(sample_rate as f64);
        state.frame_pos = N;
        state.base_frequency = abi::base_frequency();
        for index in 0..params::COUNT {
            let spec = params::spec(index);
            state.ids[index] = abi::bind_parameter(&spec.path[..spec.path_len]);
        }
        state.load_id = abi::observe_field(&VOICE_LOAD_FIELD);
        state.engine_id = abi::observe_field(&ENGINE_FIELD);
    }

    fn handle_event(state: &mut TubularState, event: &EventRecord) {
        let pitch = event.pitch.min(127) as u8;
        if event.kind == EVENT_NOTE_ON {
            let velocity = (event.velocity * 127.0 + 0.5).clamp(1.0, 127.0) as u8;
            state.synth.keydown(pitch, velocity, note_offset(event.cent, state.base_frequency));
        } else {
            state.synth.keyup(pitch);
        }
    }

    fn process_audio(state: &mut TubularState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        let mut cursor = 0;
        while cursor < out_left.len() {
            if state.frame_pos == N {
                state.synth.render_frame(&mut state.frame);
                state.frame_pos = 0;
            }
            let count = (N - state.frame_pos).min(out_left.len() - cursor);
            out_left[cursor..cursor + count].copy_from_slice(&state.frame[state.frame_pos..state.frame_pos + count]);
            state.frame_pos += count;
            cursor += count;
        }
        state.synth.fx.process(out_left);
        out_right.copy_from_slice(out_left);
    }

    fn parameter_changed(state: &mut TubularState, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {
            return;
        };
        apply(state, index, value);
    }

    /// The voice-load counter (a new value is a program change, the catch-up delivery at init is not) and
    /// the engine selector.
    fn field_changed(state: &mut TubularState, id: u32, value: FieldValue) {
        if id == state.engine_id {
            let FieldValue::Int(index) = value else {
                panic!("Tubular engine field kind mismatch");
            };
            state.synth.engine = fm::Engine::from_index(index);
            return;
        }
        if id != state.load_id {
            return;
        }
        let FieldValue::Int(count) = value else {
            panic!("Tubular voice-load field kind mismatch");
        };
        if count != state.load_count {
            state.load_count = count;
            state.synth.program_change();
        }
    }

    fn reset(state: &mut TubularState) {
        state.synth.panic();
        state.synth.fx.reset_state();
        state.frame = [0.0; N];
        state.frame_pos = N;
    }
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut TubularState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32]) {
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<Tubular>(state, [&mut *out_left, &mut *out_right], events, &block);
    Tubular::finish(state, [out_left, out_right]);
}

/// A fresh, initialised state for tests and offline renders (no host bindings).
#[cfg(not(target_family = "wasm"))]
pub fn create_state(sample_rate: f32) -> Box<TubularState> {
    let mut state: Box<TubularState> = unsafe { Box::new(core::mem::zeroed()) };
    state.synth.init(sample_rate as f64);
    state.frame_pos = N;
    state.base_frequency = 440.0;
    state
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<TubularState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<TubularState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Tubular>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Tubular as Instrument>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Tubular as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    if id as usize >= params::COUNT {
        return f32::NAN;
    }
    let spec = params::spec(id as usize);
    match spec.target {
        Target::Cutoff | Target::Resonance | Target::Output => float_value(value, &UNIPOLAR),
        Target::Tune => float_value(value, &TUNE_MAPPING),
        Target::Mono => int_value(value, &Values::new(&VOICING_MODE_VALUES)) as f32,
        Target::Byte(_) => int_value(value, &LinearInteger {min: 0, max: spec.max}) as f32,
        Target::OpSwitch(_) => int_value(value, &LinearInteger {min: 0, max: 1}) as f32
    }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Tubular as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Tubular as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use abi::EVENT_NOTE_OFF;

    const SR: f32 = 48_000.0;

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 100.0 / 127.0, cent: 0.0, duration: 0.0}
    }

    fn note_off(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
    }

    #[test]
    fn init_voice_sounds_and_releases() {
        let mut state = create_state(SR);
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right);
        assert!(peak(&left) > 0.05, "a held note is audible, got {}", peak(&left));
        assert_eq!(left, right);
        render(&mut state, &[note_off(1, 60)], &mut left, &mut right);
        for _ in 0..20 {
            render(&mut state, &[], &mut left, &mut right);
        }
        assert!(peak(&left) < 1.0e-3, "a released note decays to silence, got {}", peak(&left));
    }

    #[test]
    fn map_parameter_covers_every_binding_and_stops_after() {
        for id in 0..params::COUNT as u32 {
            assert!(!map_parameter(id, 1.0).is_nan(), "id {id}");
        }
        assert!(map_parameter(params::COUNT as u32, 1.0).is_nan());
        assert_eq!(map_parameter(5, 1.0), 31.0, "algorithm max");
        assert_eq!(map_parameter(24 + 22 * 5 + 20, 1.0), 14.0, "OP6 detune max");
        assert_eq!(map_parameter(24 + 21, 0.0), 0.0, "OP1 switch off");
    }

    #[test]
    fn a_program_change_cuts_the_previous_voice_at_once() {
        let mut state = create_state(SR);
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right);
        render(&mut state, &[note_off(1, 60)], &mut left, &mut right);
        assert!(peak(&left) > 0.01, "the release tail is sounding, got {}", peak(&left));
        let load_id = state.load_id;
        <Tubular as Instrument>::field_changed(&mut state, load_id, FieldValue::Int(1));
        render(&mut state, &[], &mut left, &mut right);
        assert!(peak(&left[N..]) < 1.0e-4, "silent after the program change, got {}", peak(&left[N..]));
        let load_id = state.load_id;
        <Tubular as Instrument>::field_changed(&mut state, load_id, FieldValue::Int(1));
        render(&mut state, &[note_on(2, 64)], &mut left, &mut right);
        assert!(peak(&left) > 0.05, "the same counter again is not a program change, got {}", peak(&left));
    }

    #[test]
    fn transpose_while_held_retunes_and_still_releases() {
        let zero_crossings = |samples: &[f32]| samples.windows(2).filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0).count();
        let mut state = create_state(SR);
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right);
        render(&mut state, &[], &mut left, &mut right);
        let before = zero_crossings(&left);
        state.synth.set_byte(144, 36); // one octave up
        render(&mut state, &[], &mut left, &mut right);
        render(&mut state, &[], &mut left, &mut right);
        let after = zero_crossings(&left);
        assert!(after > before * 3 / 2, "held note follows transpose: {before} -> {after} crossings");
        render(&mut state, &[note_off(1, 60)], &mut left, &mut right);
        for _ in 0..20 {
            render(&mut state, &[], &mut left, &mut right);
        }
        assert!(peak(&left) < 1.0e-3, "released after the transpose change, got {}", peak(&left));
    }

    #[test]
    fn transport_reset_silences_everything() {
        let mut state = create_state(SR);
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right);
        <Tubular as Instrument>::reset(&mut state);
        render(&mut state, &[], &mut left, &mut right);
        assert!(peak(&left) < 1.0e-4, "silent after reset, got {}", peak(&left));
    }
}
