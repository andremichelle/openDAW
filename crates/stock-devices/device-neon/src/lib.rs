//! `device-neon`, the CZ-101-style phase-distortion instrument (see `plans/neon.md`): two LINES, each a
//! bent-cosine oscillator with its own pitch / DCW / DCA 8-stage envelopes and key follows, combined per the
//! line select with ring / noise modulation, plus vibrato, detune, glide and mono/poly voicing through the
//! shared `voicing` framework. The 21 automatable parameters arrive as normal bound parameters; the six
//! envelopes' 108 stage fields are plain `observe_field` observations pushed raw (0-99) — the DSP owns the
//! hardware value tables (rates, DCA dB curve, DCW curve), all marked as calibration approximations.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed`, `field_changed`, `map_parameter`, `reset`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, Block, EventRecord, FieldValue, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use dsp::{midi_to_hz_base, ppqn};
use math::value_mapping::{Linear, LinearInteger, Values};
use voicing::{Voicing, VoicingMode};

#[cfg(not(target_family = "wasm"))]
pub mod calibration;
mod envelope;
mod pd;
mod voice;
use envelope::EnvelopeSpec;
use voice::{NeonParams, NeonVoice};

// The vibrato mappings, derived from the HARDWARE sysex tables (the PVSV / PVDV internal increments are
// piecewise-doubling ramps; see the youngmonkey spec). Scales calibrated to the VirtualCZ a03 render:
// rate 25 ≈ 2Hz and depth 20 ≈ ±60 cents (the 2Hz/4Hz AM pair = the LFO sweeping the detune beat through
// zero); the delay scale is a single-constant estimate.
pub(crate) fn vibrato_delay_seconds(raw: f32) -> f32 {
    raw / 99.0 * 3.0
}

fn vibrato_rate_increment(value: i32) -> i32 {
    match value {
        0..=31 => 32 * (value + 1),
        32..=47 => 1120 + 64 * (value - 32),
        48..=63 => 2272 + 128 * (value - 48),
        64..=79 => 4576 + 256 * (value - 64),
        80..=95 => 9184 + 512 * (value - 80),
        _ => 18400 + 1024 * (value - 96)
    }
}

pub(crate) fn vibrato_rate_hz(raw: f32) -> f32 {
    let value = raw.clamp(0.0, 99.0);
    let lower = value as i32;
    let fraction = value - lower as f32;
    let from = vibrato_rate_increment(lower) as f32;
    let to = vibrato_rate_increment((lower + 1).min(99)) as f32;
    0.00183 * (from + (to - from) * fraction) // measured: rates 25/50 -> 1.54/4.62 Hz on VirtualCZ
}

pub(crate) fn vibrato_depth_cents(raw: f32) -> f32 {
    // Measured on VirtualCZ (instantaneous-frequency probes): ≈1.8ct per step up to 30 (linear),
    // then the piecewise-doubling hardware ramp takes over — ±185ct @60, ±611ct @99 (wide-range probes).
    const POINTS: [(f32, f32); 7] =
        [(0.0, 0.0), (5.0, 8.9), (10.0, 18.6), (20.0, 35.1), (30.0, 52.9), (60.0, 185.0), (99.0, 611.0)];
    let value = raw.clamp(0.0, 99.0);
    let mut result = POINTS[POINTS.len() - 1].1;
    for pair in POINTS.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if value <= x1 {
            let t = (value - x0) / (x1 - x0);
            result = if y0 <= 0.0 {y1 * t} else {y0 * libm::powf(y1 / y0, t)};
            break;
        }
    }
    result
}

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const POLY_VOICES: usize = 16;
const MONO_STACK: usize = 16;

const LINE_SELECT_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const MODULATION_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const OCTAVE_MAPPING: LinearInteger = LinearInteger {min: -3, max: 3};
const DETUNE_MAPPING: Linear = Linear {min: -4800.0, max: 4800.0};
const VIBRATO_WAVE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const CZ_MAPPING: Linear = Linear {min: 0.0, max: 99.0};
const WAVE1_MAPPING: LinearInteger = LinearInteger {min: 0, max: 7};
const WAVE2_MAPPING: LinearInteger = LinearInteger {min: 0, max: 8};
const KEY_FOLLOW_MAPPING: Linear = Linear {min: 0.0, max: 9.0};
const UNIPOLAR: Linear = Linear::unipolar();
const VOICING_MODE_VALUES: [i32; 2] = [0, 1];

// The parameter slots in bind order (the parity probe's ids).
mod param {
    pub const LINE_SELECT: usize = 0;
    pub const MODULATION: usize = 1;
    pub const OCTAVE: usize = 2;
    pub const DETUNE: usize = 3;
    pub const GLIDE_TIME: usize = 4;
    pub const VOICING_MODE: usize = 5;
    pub const VIBRATO_WAVE: usize = 6;
    pub const VIBRATO_DELAY: usize = 7;
    pub const VIBRATO_RATE: usize = 8;
    pub const VIBRATO_DEPTH: usize = 9;
    pub const LINE_A_WAVE1: usize = 10;
    pub const LINE_A_WAVE2: usize = 11;
    pub const LINE_A_DCW_KF: usize = 12;
    pub const LINE_A_DCA_KF: usize = 13;
    pub const LINE_B_WAVE1: usize = 14;
    pub const LINE_B_WAVE2: usize = 15;
    pub const LINE_B_DCW_KF: usize = 16;
    pub const LINE_B_DCA_KF: usize = 17;
    pub const COUNT: usize = 18;
}

const ENVELOPES: usize = 6;
const ENV_FIELDS: usize = 18; // 8 rates, 8 levels, sustain, end
const ENV_FIELD_COUNT: usize = ENVELOPES * ENV_FIELDS;

// The editor's envelope playheads at address.append(0) (the Vaporisateur pattern): per sounding voice
// 12 floats — (position, level) for each of the 6 envelopes in box order — with -2 closing the stream
// (-1 inside a record means "line silent"). Written only while the UI subscribes.
const PLAYHEAD_FIELD: [u16; 1] = [0];
const PLAYHEAD_STRIDE: usize = 12;
const PLAYHEAD_VALUES: usize = 64;

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block.
pub struct NeonState {
    voicing: Voicing<NeonVoice, POLY_VOICES, MONO_STACK>,
    params: NeonParams,
    blocker: DcBlocker,
    limiter: dsp::simple_limiter::SimpleLimiter,
    sample_rate: f32,
    glide_time: f64,
    detune_cents: f32,
    ids: [u32; param::COUNT],
    env_ids: [u32; ENV_FIELD_COUNT],
    playhead_id: u32,
    playhead_ptr: u32
}

/// One-pole DC blocker on the device output: the resonance waves are pinned to +1 (hardware-faithful), so
/// their mean is removed here instead of reaching the speakers.
#[derive(Default)]
struct DcBlocker {
    x1: [f32; 2],
    y1: [f32; 2]
}

impl DcBlocker {
    fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32]) {
        const R: f32 = 0.9975;
        for (channel, samples) in [out_left, out_right].into_iter().enumerate() {
            for sample in samples.iter_mut() {
                let x = *sample;
                let y = x - self.x1[channel] + R * self.y1[channel];
                self.x1[channel] = x;
                self.y1[channel] = y;
                *sample = y;
            }
        }
    }
}

fn update_detune(state: &mut NeonState) {
    state.params.detune_ratio = libm::exp2f(state.detune_cents / 1200.0);
}

/// The env-field slot for `(envelope, key)` in bind order; see `init`.
fn env_slot_value(state: &mut NeonState, index: usize, value: f32) {
    let envelope_index = index / ENV_FIELDS;
    let slot = index % ENV_FIELDS;
    let line = envelope_index / 3;
    let config = &mut state.params.lines[line];
    let spec: &mut EnvelopeSpec = match envelope_index % 3 {
        0 => &mut config.pitch_env,
        1 => &mut config.dcw_env,
        _ => &mut config.dca_env
    };
    match slot {
        0..=7 => spec.rates[slot] = value,
        8..=15 => spec.levels[slot - 8] = value,
        16 => spec.sustain = value as i32,
        _ => spec.end = value as i32
    }
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct Neon;

impl Instrument for Neon {
    type State = NeonState;

    fn init(state: &mut NeonState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.params.sample_rate = sample_rate;
        state.limiter.prepare(sample_rate);
        state.params.octave_multiplier = 1.0;
        state.params.detune_ratio = 1.0;
        for line in state.params.lines.iter_mut() {
            *line = voice::LineConfig::default();
        }
        state.playhead_id = abi::bind_broadcast(&PLAYHEAD_FIELD, PLAYHEAD_VALUES as u32);
        state.playhead_ptr = 0;
        state.ids[param::LINE_SELECT] = abi::bind_parameter(&[10]);
        state.ids[param::MODULATION] = abi::bind_parameter(&[11]);
        state.ids[param::OCTAVE] = abi::bind_parameter(&[12]);
        state.ids[param::DETUNE] = abi::bind_parameter(&[13]);
        state.ids[param::GLIDE_TIME] = abi::bind_parameter(&[15]);
        state.ids[param::VOICING_MODE] = abi::bind_parameter(&[17]);
        state.ids[param::VIBRATO_WAVE] = abi::bind_parameter(&[20, 1]);
        state.ids[param::VIBRATO_DELAY] = abi::bind_parameter(&[20, 2]);
        state.ids[param::VIBRATO_RATE] = abi::bind_parameter(&[20, 3]);
        state.ids[param::VIBRATO_DEPTH] = abi::bind_parameter(&[20, 4]);
        state.ids[param::LINE_A_WAVE1] = abi::bind_parameter(&[30, 0, 1]);
        state.ids[param::LINE_A_WAVE2] = abi::bind_parameter(&[30, 0, 2]);
        state.ids[param::LINE_A_DCW_KF] = abi::bind_parameter(&[30, 0, 3]);
        state.ids[param::LINE_A_DCA_KF] = abi::bind_parameter(&[30, 0, 4]);
        state.ids[param::LINE_B_WAVE1] = abi::bind_parameter(&[30, 1, 1]);
        state.ids[param::LINE_B_WAVE2] = abi::bind_parameter(&[30, 1, 2]);
        state.ids[param::LINE_B_DCW_KF] = abi::bind_parameter(&[30, 1, 3]);
        state.ids[param::LINE_B_DCA_KF] = abi::bind_parameter(&[30, 1, 4]);
        let mut cursor = 0;
        for envelope_index in 0..ENVELOPES as u16 {
            for key in 1..=8u16 {
                state.env_ids[cursor] = abi::observe_field(&[40, envelope_index, key]);
                cursor += 1;
            }
            for key in 11..=18u16 {
                state.env_ids[cursor] = abi::observe_field(&[40, envelope_index, key]);
                cursor += 1;
            }
            state.env_ids[cursor] = abi::observe_field(&[40, envelope_index, 20]);
            cursor += 1;
            state.env_ids[cursor] = abi::observe_field(&[40, envelope_index, 21]);
            cursor += 1;
        }
    }

    fn handle_event(state: &mut NeonState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let frequency = midi_to_hz_base(event.pitch as f32 + event.cent / 100.0, abi::base_frequency());
            state.voicing.start(event, frequency, 1.0, state.glide_time, 1, &state.params);
        } else {
            state.voicing.stop(event.id as i32, state.glide_time);
        }
    }

    fn process_audio(state: &mut NeonState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        state.voicing.process([&mut *out_left, &mut *out_right], block, &state.params);
        if option_env!("NEON_NO_BLOCKER").is_none() {
            state.blocker.process(out_left, out_right);
        }
        if option_env!("NEON_NO_LIMITER").is_none() {
            state.limiter.replace(out_left, out_right, 0, out_left.len());
        }
        if abi::broadcast_active(state.playhead_id) {
            if state.playhead_ptr == 0 {
                state.playhead_ptr = abi::broadcast_ptr(state.playhead_id);
            }
            if state.playhead_ptr != 0 {
                let values = unsafe { core::slice::from_raw_parts_mut(state.playhead_ptr as *mut f32, PLAYHEAD_VALUES) };
                let mut index = 0;
                state.voicing.for_each_active(&mut |voice: &NeonVoice| {
                    if index + PLAYHEAD_STRIDE >= PLAYHEAD_VALUES {
                        return;
                    }
                    voice.env_positions(&state.params, &mut values[index..index + PLAYHEAD_STRIDE]);
                    index += PLAYHEAD_STRIDE;
                });
                values[index] = -2.0;
            }
        }
    }

    fn parameter_changed(state: &mut NeonState, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {
            return;
        };
        match index {
            param::LINE_SELECT => state.params.line_select = int_value(value, &LINE_SELECT_MAPPING),
            param::MODULATION => state.params.modulation = int_value(value, &MODULATION_MAPPING),
            param::OCTAVE => state.params.octave_multiplier = libm::exp2f(int_value(value, &OCTAVE_MAPPING) as f32),
            param::DETUNE => {
                state.detune_cents = float_value(value, &DETUNE_MAPPING);
                update_detune(state);
            }
            param::GLIDE_TIME => state.glide_time = float_value(value, &UNIPOLAR) as f64 * ppqn::BAR,
            param::VOICING_MODE => state.voicing.set_mode(VoicingMode::from_index(int_value(value, &Values::new(&VOICING_MODE_VALUES)))),
            param::VIBRATO_WAVE => state.params.vibrato.wave = int_value(value, &VIBRATO_WAVE_MAPPING),
            param::VIBRATO_DELAY => state.params.vibrato.delay_seconds = vibrato_delay_seconds(float_value(value, &CZ_MAPPING)),
            param::VIBRATO_RATE => state.params.vibrato.rate_hz = vibrato_rate_hz(float_value(value, &CZ_MAPPING)),
            param::VIBRATO_DEPTH => state.params.vibrato.depth_cents = vibrato_depth_cents(float_value(value, &CZ_MAPPING)),
            param::LINE_A_WAVE1 => state.params.lines[0].wave1 = int_value(value, &WAVE1_MAPPING),
            param::LINE_A_WAVE2 => state.params.lines[0].wave2 = int_value(value, &WAVE2_MAPPING),
            param::LINE_A_DCW_KF => state.params.lines[0].dcw_key_follow = float_value(value, &KEY_FOLLOW_MAPPING),
            param::LINE_A_DCA_KF => state.params.lines[0].dca_key_follow = float_value(value, &KEY_FOLLOW_MAPPING),
            param::LINE_B_WAVE1 => state.params.lines[1].wave1 = int_value(value, &WAVE1_MAPPING),
            param::LINE_B_WAVE2 => state.params.lines[1].wave2 = int_value(value, &WAVE2_MAPPING),
            param::LINE_B_DCW_KF => state.params.lines[1].dcw_key_follow = float_value(value, &KEY_FOLLOW_MAPPING),
            param::LINE_B_DCA_KF => state.params.lines[1].dca_key_follow = float_value(value, &KEY_FOLLOW_MAPPING),
            _ => {}
        }
    }

    fn field_changed(state: &mut NeonState, id: u32, value: FieldValue) {
        let Some(index) = state.env_ids.iter().position(|bound| *bound == id) else {
            return;
        };
        let raw = match (index % ENV_FIELDS, value) {
            (0..=15, FieldValue::Float(rate_or_level)) => rate_or_level,
            (16 | 17, FieldValue::Int(marker)) => marker as f32,
            _ => panic!("Neon envelope field kind mismatch")
        };
        env_slot_value(state, index, raw);
    }

    fn reset(state: &mut NeonState) {
        state.voicing.reset();
        state.blocker = DcBlocker::default();
    }
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut NeonState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    state.params.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<Neon>(state, [&mut *out_left, &mut *out_right], events, &block);
    Neon::finish(state, [out_left, out_right]);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. The voice pool is fixed, so the
/// size does not depend on `sample_rate`.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NeonState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<NeonState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Neon>(ports);
}

/// Boot hook: bind the parameters + observe the envelope fields, and stash the sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Neon as Instrument>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Neon as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Apply an observed plain field's value (an envelope stage), by the id `observe_field` returned.
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Neon as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id as usize {
        param::LINE_SELECT => int_value(value, &LINE_SELECT_MAPPING) as f32,
        param::MODULATION => int_value(value, &MODULATION_MAPPING) as f32,
        param::OCTAVE => int_value(value, &OCTAVE_MAPPING) as f32,
        param::DETUNE => float_value(value, &DETUNE_MAPPING),
        param::GLIDE_TIME => float_value(value, &UNIPOLAR),
        param::VOICING_MODE => int_value(value, &Values::new(&VOICING_MODE_VALUES)) as f32,
        param::VIBRATO_WAVE => int_value(value, &VIBRATO_WAVE_MAPPING) as f32,
        param::VIBRATO_DELAY | param::VIBRATO_RATE | param::VIBRATO_DEPTH => float_value(value, &CZ_MAPPING),
        param::LINE_A_WAVE1 | param::LINE_B_WAVE1 => int_value(value, &WAVE1_MAPPING) as f32,
        param::LINE_A_WAVE2 | param::LINE_B_WAVE2 => int_value(value, &WAVE2_MAPPING) as f32,
        param::LINE_A_DCW_KF | param::LINE_A_DCA_KF | param::LINE_B_DCW_KF | param::LINE_B_DCA_KF => float_value(value, &KEY_FOLLOW_MAPPING),
        _ => f32::NAN
    }
}

/// Transport STOP: drop every voice so playback starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Neon as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use abi::EVENT_NOTE_OFF;

    const SR: f32 = 48_000.0;

    #[test]
    fn vibrato_depth_is_near_zero_at_the_bottom_and_linear_to_thirty() {
        // Measured (VirtualCZ instantaneous-frequency probe): ±1.8ct @1, ±18.6ct @10, ±52.9ct @30.
        assert!(vibrato_depth_cents(0.0) == 0.0);
        assert!(vibrato_depth_cents(1.0) < 3.0, "depth 1 = {}", vibrato_depth_cents(1.0));
        assert!((vibrato_depth_cents(10.0) - 18.6).abs() < 1.0);
        assert!((vibrato_depth_cents(30.0) - 52.9).abs() < 1.0);
        assert!((vibrato_depth_cents(99.0) - 611.0).abs() < 1.0);
    }

    fn organ_env() -> EnvelopeSpec {
        EnvelopeSpec {rates: [99.0; 8], levels: [99.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], sustain: 1, end: 2}
    }

    fn configured() -> NeonState {
        let mut state: NeonState = unsafe { core::mem::zeroed() };
        state.sample_rate = SR;
        state.params.sample_rate = SR;
        state.params.octave_multiplier = 1.0;
        state.params.detune_ratio = 1.0;
        state.params.lines[0].dcw_env = organ_env();
        state.params.lines[0].dca_env = organ_env();
        state.params.lines[1].dcw_env = organ_env();
        state.params.lines[1].dca_env = organ_env();
        state
    }

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
    }

    fn note_off(id: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
    }

    #[test]
    fn a_held_note_sounds_and_a_released_note_decays_to_silence() {
        let mut state = configured();
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.05, "a held note is audible, got {}", peak(&left));
        render(&mut state, &[note_off(1)], &mut left, &mut right, SR);
        for _ in 0..10 {
            render(&mut state, &[], &mut left, &mut right, SR);
        }
        assert!(peak(&left) < 1.0e-3, "a released note decays to silence, got {}", peak(&left));
    }

    #[test]
    fn env_positions_broadcast_layout_is_pitch_dcw_dca_per_line() {
        let mut state = configured();
        state.params.lines[0].pitch_env = EnvelopeSpec {
            rates: [99.0; 8], levels: [40.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], sustain: 1, end: 2
        };
        state.params.lines[0].dcw_env = EnvelopeSpec {
            rates: [99.0; 8], levels: [80.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], sustain: 1, end: 2
        };
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        let mut values = [0.0f32; 12];
        let mut count = 0;
        state.voicing.for_each_active(&mut |voice: &voice::NeonVoice| {
            voice.env_positions(&state.params, &mut values);
            count += 1;
        });
        assert_eq!(count, 1);
        assert!((values[1] - 40.0 / 99.0).abs() < 0.02, "pitch level slot, got {}", values[1]);
        assert!((values[3] - 80.0 / 99.0).abs() < 0.02, "dcw level slot, got {}", values[3]);
        assert!((values[5] - 1.0).abs() < 0.02, "dca level slot, got {}", values[5]);
        assert!(values[6] == -1.0, "line 2 silent in lineSelect 0, got {}", values[6]);
    }

    #[test]
    fn a_line_routed_in_after_note_off_still_dies() {
        // Switching line select can route slot 1 in AFTER the release only touched slot 0 — the
        // late slot must not play its attack and sustain forever (the stuck-voice report). Slot 0
        // gets a SLOW release tail so the voice is still alive when the mode changes.
        let mut state = configured();
        state.params.lines[0].dca_env.rates[1] = 40.0;
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        render(&mut state, &[note_off(1)], &mut left, &mut right, SR);
        state.params.line_select = 3; // 1+2' now routes slot 1, whose envelopes were never released
        for _ in 0..20 {
            render(&mut state, &[], &mut left, &mut right, SR);
        }
        assert!(peak(&left) < 1.0e-3, "the late-routed line decays to silence, got {}", peak(&left));
    }

    #[test]
    fn line_select_dual_is_louder_than_single_and_detune_applies() {
        let mut state = configured();
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        let single: f32 = left.iter().map(|value| value * value).sum();
        let mut state = configured();
        state.params.line_select = 2; // 1+1'
        state.params.detune_ratio = libm::exp2f(7.0 / 12.0);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        let dual: f32 = left.iter().map(|value| value * value).sum();
        assert!(dual > single * 1.5, "two lines carry more energy: single {single} dual {dual}");
    }

    #[test]
    fn dcw_amount_brightens_the_saw() {
        let zero_crossings = |samples: &[f32]| samples.windows(2).filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0).count();
        let mut dull = configured();
        dull.params.lines[0].dcw_env.levels[0] = 5.0; // nearly pure cosine
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut dull, &[note_on(1, 60)], &mut left, &mut right, SR);
        let dull_peak = peak(&left);
        let mut bright = configured(); // DCW level 99: full saw
        render(&mut bright, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.05 && dull_peak > 0.05, "both audible");
        let _ = zero_crossings;
    }

    #[test]
    fn mono_retrigger_fades_the_stolen_voice_without_a_click() {
        let mut state = configured();
        // Nearly pure cosine (smooth waveform) with a LONG release so the tail is loud at retrigger.
        state.params.lines[0].dcw_env.levels[0] = 0.0;
        state.params.lines[0].dca_env.rates[1] = 25.0;
        state.voicing.set_mode(VoicingMode::Monophonic);
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        let mut stitched: Vec<f32> = Vec::new();
        render(&mut state, &[note_on(1, 48)], &mut left, &mut right, SR);
        render(&mut state, &[note_off(1)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.05, "the release tail is still audible, got {}", peak(&left));
        stitched.extend_from_slice(&left);
        render(&mut state, &[note_on(2, 55)], &mut left, &mut right, SR);
        stitched.extend_from_slice(&left);
        let max_delta = stitched.windows(2).map(|pair| (pair[1] - pair[0]).abs()).fold(0.0f32, f32::max);
        assert!(max_delta < 0.02, "a mono retrigger must fade the old voice, not cut it: max sample delta {max_delta}");
    }

    #[test]
    fn transport_reset_silences_everything() {
        let mut state = configured();
        let (mut left, mut right) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        <Neon as Instrument>::reset(&mut state);
        render(&mut state, &[], &mut left, &mut right, SR);
        assert!(peak(&left) < 1.0e-4, "silent after reset, got {}", peak(&left));
    }
}
