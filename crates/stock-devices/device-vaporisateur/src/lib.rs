//! The Vaporisateur, a polyphonic two-oscillator subtractive synth, as a runtime-loadable INSTRUMENT device:
//! a faithful port of the TS `VaporisateurDeviceProcessor` / `VaporisateurVoice`. Two band-limited
//! oscillators (per-osc waveform / octave / tune / volume) are mixed, run through a modulated multi-pole
//! low-pass (cutoff + resonance + filter-envelope + keyboard tracking), and shaped by an ADSR VCA. A glide
//! gives portamento, an LFO modulates tune / cutoff / volume, and the note is rendered through the shared
//! `voicing` framework: `unison` detuned/spread sub-voices per note ([`voicing::VoiceUnison`]), allocated
//! either polyphonically or monophonically ([`voicing::Voicing`] dispatcher, switched by the voicing-mode
//! parameter). The whole mix is brick-wall limited (`dsp::simple_limiter`).
//!
//! Heap-free: every voice lives in the engine-allocated (zeroed) state block, reused across notes (no `new`
//! per note, no allocator). The voice reads the device's live parameters through `voicing`'s `Shared`
//! associated type ([`voice::VaporisateurParams`]) at note-on (envelope, keyboard tracking, sample rate) and
//! each chunk (oscillators, filter, LFO), and shares one reusable render workspace (no per-call scratch). The
//! ADSR is a LOCAL implementation ([`mod@adsr`], a port of lib-dsp `adsr.ts`), NOT the shared `dsp::adsr`. The
//! noise generator in the box schema is unused by the TS DSP, so it is absent.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, Block, EventRecord, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use dsp::osc::ClassicWaveform;
use dsp::{midi_to_hz, ppqn};
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger, Values, ValueMapping};
use math::db_to_gain;
use voicing::{VoiceUnison, Voicing, VoicingMode};

mod adsr;
mod voice;
use voice::{VaporisateurParams, VaporisateurVoice};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const POLY_VOICES: usize = 16; // polyphonic voice slots
const MONO_STACK: usize = 16; // monophonic held-note stack depth
const UNISON_MAX: usize = 5; // the widest unison (the unison-count values are [1, 3, 5])

// This device's value mappings (uniform 0..1 -> the parameter's real value), mirroring the TS adapter.
const VOLUME_MAPPING: Decibel = Decibel::default_volume(); // osc volume (decibel(-72, -12, 0))
const TUNE_MAPPING: Linear = Linear {min: -1200.0, max: 1200.0}; // osc tune (cents)
const OCTAVE_MAPPING: LinearInteger = LinearInteger {min: -3, max: 3}; // osc octave
const OSC_WAVEFORM_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3}; // osc waveform index
const CUTOFF_MAPPING: Exponential = Exponential {min: 20.0, max: 20_000.0}; // cutoff (used as a UNIT value)
const RESONANCE_MAPPING: Exponential = Exponential {min: 0.01, max: 10.0}; // filter Q
const TIME_MAPPING: Exponential = Exponential {min: 0.001, max: 5.0}; // attack / decay / release (seconds)
const DETUNE_MAPPING: Exponential = Exponential {min: 1.0, max: 1200.0}; // unison detune (cents)
const LFO_RATE_MAPPING: Exponential = Exponential {min: 0.0001, max: 30.0}; // LFO rate (Hz)
const BIPOLAR: Linear = Linear::bipolar(); // filter-envelope / keyboard / LFO targets
const UNIPOLAR: Linear = Linear::unipolar(); // sustain / glide-time / unison-stereo
const FILTER_ORDER_VALUES: [i32; 4] = [1, 2, 3, 4];
const UNISON_COUNT_VALUES: [i32; 3] = [1, 3, 5];
const VOICING_MODE_VALUES: [i32; 2] = [0, 1]; // VoicingMode::{Monophonic, Polyphonic}
const LFO_WAVEFORM_VALUES: [i32; 4] = [0, 1, 2, 3];

// The parameter slots, the order this device binds them. The id `bind_parameter` returns is stored in
// `state.ids[INDEX]`; `parameter_changed` finds the slot by matching the incoming id against that table.
mod param {
    pub const OSC_A_WAVEFORM: usize = 0;
    pub const OSC_A_VOLUME: usize = 1;
    pub const OSC_A_OCTAVE: usize = 2;
    pub const OSC_A_TUNE: usize = 3;
    pub const OSC_B_WAVEFORM: usize = 4;
    pub const OSC_B_VOLUME: usize = 5;
    pub const OSC_B_OCTAVE: usize = 6;
    pub const OSC_B_TUNE: usize = 7;
    pub const ATTACK: usize = 8;
    pub const DECAY: usize = 9;
    pub const SUSTAIN: usize = 10;
    pub const RELEASE: usize = 11;
    pub const CUTOFF: usize = 12;
    pub const RESONANCE: usize = 13;
    pub const FILTER_ENVELOPE: usize = 14;
    pub const FILTER_ORDER: usize = 15;
    pub const FILTER_KEYBOARD: usize = 16;
    pub const GLIDE_TIME: usize = 17;
    pub const VOICING_MODE: usize = 18;
    pub const UNISON_COUNT: usize = 19;
    pub const UNISON_DETUNE: usize = 20;
    pub const UNISON_STEREO: usize = 21;
    pub const LFO_WAVEFORM: usize = 22;
    pub const LFO_RATE: usize = 23;
    pub const LFO_TARGET_TUNE: usize = 24;
    pub const LFO_TARGET_CUTOFF: usize = 25;
    pub const LFO_TARGET_VOLUME: usize = 26;
    pub const COUNT: usize = 27;
}

/// Resolve the cutoff as a UNIT value (0..1): the automation value directly, or a real Hz mapped back to the
/// unit interval (the filter maps it to Hz itself, so the device keeps the cutoff normalised — TS `getUnitValue`).
fn cutoff_unit(value: ParamValue) -> f32 {
    match value {
        ParamValue::Unit(unit) => unit,
        ParamValue::Float(real) => CUTOFF_MAPPING.x(real),
        ParamValue::Int(real) => CUTOFF_MAPPING.x(real as f32),
        ParamValue::Bool(flag) => if flag {1.0} else {0.0}
    }
}

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block: the voicing
/// dispatcher (both strategies + the unison voice pools), the live parameters the voices read (including the
/// shared render workspace), the output limiter, the sample rate, the per-note glide time (pulses) and unison
/// count, and the bound parameter ids.
pub struct VaporisateurState {
    voicing: Voicing<VoiceUnison<VaporisateurVoice, UNISON_MAX>, POLY_VOICES, MONO_STACK>,
    params: VaporisateurParams,
    limiter: dsp::simple_limiter::SimpleLimiter,
    sample_rate: f32,
    glide_time: f64,
    unison_count: i32,
    ids: [u32; param::COUNT]
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct Vaporisateur;

impl Instrument for Vaporisateur {
    type State = VaporisateurState;

    fn init(state: &mut VaporisateurState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        state.params.sample_rate = sample_rate;
        state.limiter.prepare(sample_rate);
        state.ids[param::OSC_A_WAVEFORM] = abi::bind_parameter(&[40, 0, 1]);
        state.ids[param::OSC_A_VOLUME] = abi::bind_parameter(&[40, 0, 2]);
        state.ids[param::OSC_A_OCTAVE] = abi::bind_parameter(&[40, 0, 3]);
        state.ids[param::OSC_A_TUNE] = abi::bind_parameter(&[40, 0, 4]);
        state.ids[param::OSC_B_WAVEFORM] = abi::bind_parameter(&[40, 1, 1]);
        state.ids[param::OSC_B_VOLUME] = abi::bind_parameter(&[40, 1, 2]);
        state.ids[param::OSC_B_OCTAVE] = abi::bind_parameter(&[40, 1, 3]);
        state.ids[param::OSC_B_TUNE] = abi::bind_parameter(&[40, 1, 4]);
        state.ids[param::ATTACK] = abi::bind_parameter(&[16]);
        state.ids[param::DECAY] = abi::bind_parameter(&[19]);
        state.ids[param::SUSTAIN] = abi::bind_parameter(&[20]);
        state.ids[param::RELEASE] = abi::bind_parameter(&[17]);
        state.ids[param::CUTOFF] = abi::bind_parameter(&[14]);
        state.ids[param::RESONANCE] = abi::bind_parameter(&[15]);
        state.ids[param::FILTER_ENVELOPE] = abi::bind_parameter(&[18]);
        state.ids[param::FILTER_ORDER] = abi::bind_parameter(&[26]);
        state.ids[param::FILTER_KEYBOARD] = abi::bind_parameter(&[27]);
        state.ids[param::GLIDE_TIME] = abi::bind_parameter(&[21]);
        state.ids[param::VOICING_MODE] = abi::bind_parameter(&[22]);
        state.ids[param::UNISON_COUNT] = abi::bind_parameter(&[23]);
        state.ids[param::UNISON_DETUNE] = abi::bind_parameter(&[24]);
        state.ids[param::UNISON_STEREO] = abi::bind_parameter(&[25]);
        state.ids[param::LFO_WAVEFORM] = abi::bind_parameter(&[30, 1]);
        state.ids[param::LFO_RATE] = abi::bind_parameter(&[30, 2]);
        state.ids[param::LFO_TARGET_TUNE] = abi::bind_parameter(&[30, 10]);
        state.ids[param::LFO_TARGET_CUTOFF] = abi::bind_parameter(&[30, 11]);
        state.ids[param::LFO_TARGET_VOLUME] = abi::bind_parameter(&[30, 12]);
    }

    fn handle_event(state: &mut VaporisateurState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let frequency = midi_to_hz(event.pitch as f32 + event.cent / 100.0);
            let glide_time = state.glide_time;
            let unison = state.unison_count.max(1) as usize;
            state.voicing.start(event, frequency, 1.0, glide_time, unison, &state.params);
        } else {
            state.voicing.stop(event.id as i32, state.glide_time);
        }
    }

    fn process_audio(state: &mut VaporisateurState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        state.voicing.process([&mut *out_left, &mut *out_right], block, &state.params);
        state.limiter.replace(out_left, out_right, 0, out_left.len());
    }

    fn parameter_changed(state: &mut VaporisateurState, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {
            return;
        };
        let params = &mut state.params;
        match index {
            param::OSC_A_WAVEFORM => params.osc_a_waveform = ClassicWaveform::from_index(int_value(value, &OSC_WAVEFORM_MAPPING)),
            param::OSC_B_WAVEFORM => params.osc_b_waveform = ClassicWaveform::from_index(int_value(value, &OSC_WAVEFORM_MAPPING)),
            param::OSC_A_VOLUME => params.gain_osc_a = db_to_gain(float_value(value, &VOLUME_MAPPING)),
            param::OSC_B_VOLUME => params.gain_osc_b = db_to_gain(float_value(value, &VOLUME_MAPPING)),
            param::OSC_A_OCTAVE => {
                params.osc_a_octave = int_value(value, &OCTAVE_MAPPING);
                params.frequency_a_multiplier = libm::exp2f(params.osc_a_octave as f32 + params.osc_a_tune / 1200.0);
            }
            param::OSC_A_TUNE => {
                params.osc_a_tune = float_value(value, &TUNE_MAPPING);
                params.frequency_a_multiplier = libm::exp2f(params.osc_a_octave as f32 + params.osc_a_tune / 1200.0);
            }
            param::OSC_B_OCTAVE => {
                params.osc_b_octave = int_value(value, &OCTAVE_MAPPING);
                params.frequency_b_multiplier = libm::exp2f(params.osc_b_octave as f32 + params.osc_b_tune / 1200.0);
            }
            param::OSC_B_TUNE => {
                params.osc_b_tune = float_value(value, &TUNE_MAPPING);
                params.frequency_b_multiplier = libm::exp2f(params.osc_b_octave as f32 + params.osc_b_tune / 1200.0);
            }
            param::ATTACK => params.env_attack = float_value(value, &TIME_MAPPING),
            param::DECAY => params.env_decay = float_value(value, &TIME_MAPPING),
            param::SUSTAIN => params.env_sustain = float_value(value, &UNIPOLAR),
            param::RELEASE => params.env_release = float_value(value, &TIME_MAPPING),
            param::CUTOFF => params.flt_cutoff = cutoff_unit(value),
            param::RESONANCE => params.flt_resonance = float_value(value, &RESONANCE_MAPPING),
            param::FILTER_ENVELOPE => params.flt_env_amount = float_value(value, &BIPOLAR),
            param::FILTER_ORDER => params.flt_order = int_value(value, &Values::new(&FILTER_ORDER_VALUES)),
            param::FILTER_KEYBOARD => params.filter_keyboard = float_value(value, &BIPOLAR),
            param::UNISON_DETUNE => params.unison_detune = float_value(value, &DETUNE_MAPPING),
            param::UNISON_STEREO => params.unison_stereo = float_value(value, &UNIPOLAR),
            param::LFO_WAVEFORM => params.lfo_shape = ClassicWaveform::from_index(int_value(value, &Values::new(&LFO_WAVEFORM_VALUES))),
            param::LFO_RATE => params.lfo_rate = float_value(value, &LFO_RATE_MAPPING),
            param::LFO_TARGET_TUNE => params.lfo_target_tune = float_value(value, &BIPOLAR),
            param::LFO_TARGET_CUTOFF => params.lfo_target_cutoff = float_value(value, &BIPOLAR),
            param::LFO_TARGET_VOLUME => params.lfo_target_volume = float_value(value, &BIPOLAR),
            param::GLIDE_TIME => state.glide_time = float_value(value, &UNIPOLAR) as f64 * ppqn::BAR,
            param::UNISON_COUNT => state.unison_count = int_value(value, &Values::new(&UNISON_COUNT_VALUES)),
            param::VOICING_MODE => state.voicing.set_mode(VoicingMode::from_index(int_value(value, &Values::new(&VOICING_MODE_VALUES)))),
            _ => {}
        }
    }

    fn reset(state: &mut VaporisateurState) {
        state.voicing.reset();
    }
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut VaporisateurState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    state.params.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<Vaporisateur>(state, [&mut *out_left, &mut *out_right], events, &block);
    Vaporisateur::finish(state, [out_left, out_right]);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. The voice pools are fixed, so the
/// size does not depend on `sample_rate`.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<VaporisateurState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<VaporisateurState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Vaporisateur>(ports);
}

/// Boot hook: bind this device's parameters with the host (it records their field-paths and returns an id
/// each) and stash the (stable) sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Vaporisateur as Instrument>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back. The
/// `kind` tag tells the SDK how to type the f32 `value` into a `ParamValue`.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Vaporisateur as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: drop every voice (force-stop the voicing) so playback starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Vaporisateur as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    //! The Vaporisateur voice chain driven through the ABI's `Instrument` dispatch: a held note produces a
    //! bounded, non-silent tone; releasing it decays to silence; a low cutoff attenuates a bright saw; and
    //! polyphony sums independent voices. In-crate so the tests can set the private state directly.
    use super::*;

    const SR: f32 = 48_000.0;

    /// A zeroed state configured for a clearly audible patch: oscillator A a saw at unity, B silent, the
    /// filter wide open, a fast envelope, polyphonic, one unison voice. (The engine pushes the real defaults
    /// via `parameter_changed`; the tests set the fields the DSP reads directly.)
    fn configured(mode: VoicingMode) -> VaporisateurState {
        let mut state: VaporisateurState = unsafe { core::mem::zeroed() };
        state.sample_rate = SR;
        state.params.sample_rate = SR;
        state.limiter.prepare(SR);
        state.unison_count = 1;
        state.glide_time = 0.0;
        state.voicing.set_mode(mode);
        let params = &mut state.params;
        params.gain_osc_a = 1.0;
        params.gain_osc_b = 0.0;
        params.osc_a_waveform = ClassicWaveform::Saw;
        params.osc_b_waveform = ClassicWaveform::Saw;
        params.frequency_a_multiplier = 1.0;
        params.frequency_b_multiplier = 1.0;
        params.env_attack = 0.001;
        params.env_decay = 0.001;
        params.env_sustain = 1.0;
        params.env_release = 0.050;
        params.flt_cutoff = 1.0; // wide open
        params.flt_resonance = 0.7;
        params.flt_env_amount = 0.0;
        params.flt_order = 1;
        params.filter_keyboard = 0.0;
        params.lfo_shape = ClassicWaveform::Sine;
        params.lfo_rate = 0.0;
        params.unison_detune = 30.0;
        params.unison_stereo = 1.0;
        state
    }

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0}
    }

    fn note_off(id: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: abi::EVENT_NOTE_OFF, id, pitch: 0, velocity: 0.0, cent: 0.0}
    }

    fn peak(buffer: &[f32]) -> f32 {
        buffer.iter().fold(0.0f32, |acc, sample| acc.max(sample.abs()))
    }

    fn rms(buffer: &[f32]) -> f32 {
        let sum: f32 = buffer.iter().map(|sample| sample * sample).sum();
        libm::sqrtf(sum / buffer.len() as f32)
    }

    #[test]
    fn a_held_note_produces_a_bounded_tone() {
        let mut state = configured(VoicingMode::Polyphonic);
        let (mut left, mut right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut state, &[note_on(1, 69)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.01, "the note sounds, got peak {}", peak(&left));
        // The 3 ms-attack feedback limiter rides the signal level, so single-sample saw / BLEP spikes leak
        // slightly above unity (as in the TS SimpleLimiter); it stays bounded near unity, never running away.
        assert!(peak(&left) < 1.5, "the limiter keeps it bounded near unity, got {}", peak(&left));
        assert_eq!(left, right, "a centred mono note is equal on both channels");
    }

    #[test]
    fn no_note_is_silent() {
        let mut state = configured(VoicingMode::Polyphonic);
        let (mut left, mut right) = (vec![0.0f32; 1024], vec![0.0f32; 1024]);
        render(&mut state, &[], &mut left, &mut right, SR);
        assert_eq!(peak(&left), 0.0, "no events, no sound");
    }

    #[test]
    fn releasing_a_note_decays_to_silence() {
        let mut state = configured(VoicingMode::Polyphonic);
        let (mut left, mut right) = (vec![0.0f32; 256], vec![0.0f32; 256]);
        // Note on, sustain a moment, then off; render well past the 50 ms release.
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.01, "sustaining while held");
        let (mut tail_left, mut tail_right) = (vec![0.0f32; 8192], vec![0.0f32; 8192]);
        render(&mut state, &[note_off(1)], &mut tail_left, &mut tail_right, SR);
        let release_tail = &tail_left[6000..]; // past 50 ms (2400 samples) at 48 kHz
        assert!(peak(release_tail) < 1.0e-4, "decays to silence, got {}", peak(release_tail));
    }

    #[test]
    fn a_low_cutoff_attenuates_a_bright_saw() {
        let mut open = configured(VoicingMode::Polyphonic);
        let (mut open_left, mut open_right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut open, &[note_on(1, 81)], &mut open_left, &mut open_right, SR);
        let mut closed = configured(VoicingMode::Polyphonic);
        closed.params.flt_cutoff = 0.05; // a low cutoff removes the saw's upper harmonics
        let (mut closed_left, mut closed_right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut closed, &[note_on(1, 81)], &mut closed_left, &mut closed_right, SR);
        assert!(rms(&closed_left) < rms(&open_left), "a low cutoff is quieter ({} vs {})", rms(&closed_left), rms(&open_left));
    }

    #[test]
    fn polyphony_sums_independent_notes() {
        let mut state = configured(VoicingMode::Polyphonic);
        let (mut left, mut right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut state, &[note_on(1, 60), note_on(2, 67)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.01, "a chord sounds");
        // Both note ids are voiced (the pool allocated two slots), so a second note adds energy over one.
        let mut single = configured(VoicingMode::Polyphonic);
        let (mut single_left, mut single_right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut single, &[note_on(1, 60)], &mut single_left, &mut single_right, SR);
        assert!(rms(&left) > rms(&single_left), "two notes carry more energy than one");
    }

    #[test]
    fn monophonic_mode_voices_a_note() {
        let mut state = configured(VoicingMode::Monophonic);
        let (mut left, mut right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        render(&mut state, &[note_on(1, 64)], &mut left, &mut right, SR);
        assert!(peak(&left) > 0.01, "the monophonic strategy sounds a note");
    }
}
