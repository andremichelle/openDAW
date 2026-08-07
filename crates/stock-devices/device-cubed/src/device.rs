//! The ABI surface: one instrument device wrapping merger + voice.
//!
//! Event flow is strictly one-way and single-file:
//!     host note events -> NoteMerger -> VoiceCommand -> Voice303 -> audio
//! Nothing else may touch the voice. The 303's state is order-dependent (accent-cap depletion,
//! slide-into-next-note, envelope recharge), so a second writer would reproduce the defects the
//! ar-303 calibration removed.

use crate::merger::VoiceCommand;
use crate::{ensure_tables, NoteMerger, Source, Tables, Voice303};
use abi::{Block, EventRecord, ParamValue, EVENT_NOTE_ON};

/// Parameter slots, in bind order. The id `bind_parameter` returns is stored in `state.ids[SLOT]`;
/// `parameter_changed` finds the slot by matching the incoming id against that table.
///
/// The FIELD INDICES come from `CubedDeviceBox.ts`, but the value MAPPINGS come from
/// `CubedDeviceBoxAdapter`'s `createParameter` calls - the schema's constraints are not the source
/// of truth for what a value means on the wire.
mod param {
    pub const TUNING: usize = 0;
    pub const CUTOFF: usize = 1;
    pub const RESONANCE: usize = 2;
    pub const ENV_MOD: usize = 3;
    pub const DECAY: usize = 4;
    pub const ACCENT: usize = 5;
    pub const VOLUME: usize = 6;
    pub const WAVEFORM: usize = 7;
    pub const COUNT: usize = 8;
}

/// Rendered in chunks so the mono voice can be summed into both channels without a heap buffer.
const SCRATCH: usize = 128;

pub struct State {
    pub voice: Voice303,
    pub merger: NoteMerger,
    tables: Option<&'static Tables>,
    ids: [u32; param::COUNT]
}

impl State {
    /// Built IN PLACE over the engine's zeroed state block. `Voice303` is not valid when zeroed -
    /// it starts with charges at 1.0 and a non-zero semitone - so this device cannot rely on the
    /// zeroed-is-valid shortcut the simpler stock devices use.
    pub fn init_in_place(state: &mut Self, sample_rate: f32) {
        state.voice = Voice303::new(sample_rate as f64);
        state.merger = NoteMerger::new();
        // SAFETY: `init` is a boot hook, called outside `process`.
        state.tables = Some(unsafe {ensure_tables()});
    }

    fn apply(&mut self, command: Option<VoiceCommand>) {
        match command {
            Some(VoiceCommand::NoteOn {pitch, accent, slide}) => self.voice.note_on(pitch, accent, slide),
            Some(VoiceCommand::NoteOff) => self.voice.note_off(),
            None => {}
        }
    }
}

pub struct Device;

impl abi::Instrument for Device {
    type State = State;

    fn init(state: &mut State, sample_rate: f32) {
        State::init_in_place(state, sample_rate);
        // field indices from CubedDeviceBox.ts
        state.ids[param::TUNING] = abi::bind_parameter(&[10]);
        state.ids[param::CUTOFF] = abi::bind_parameter(&[11]);
        state.ids[param::RESONANCE] = abi::bind_parameter(&[12]);
        state.ids[param::ENV_MOD] = abi::bind_parameter(&[13]);
        state.ids[param::DECAY] = abi::bind_parameter(&[14]);
        state.ids[param::ACCENT] = abi::bind_parameter(&[15]);
        state.ids[param::VOLUME] = abi::bind_parameter(&[16]);
        state.ids[param::WAVEFORM] = abi::bind_parameter(&[17]);
    }

    fn parameter_changed(state: &mut State, id: u32, value: ParamValue) {
        let Some(slot) = state.ids.iter().position(|bound| *bound == id) else {return};
        apply_slot(&mut state.voice.params, slot, value);
    }

    fn process_audio(state: &mut State, output: [&mut [f32]; 2], _block: &Block) {
        let Some(tables) = state.tables else {return};
        let [out_left, out_right] = output;
        let length = out_left.len().min(out_right.len());
        let mut scratch = [0.0f32; SCRATCH];
        let mut done = 0;
        while done < length {
            let chunk = (length - done).min(SCRATCH);
            state.voice.process_block(tables, &mut scratch, 0, chunk);
            // additive, per the template contract: the engine may be summing several sources into
            // this buffer, so the device must never assign over it
            for i in 0..chunk {
                out_left[done + i] += scratch[i];
                out_right[done + i] += scratch[i];
            }
            done += chunk;
        }
    }

    fn handle_event(state: &mut State, event: &EventRecord) {
        // Live input only: accent and slide are INFERRED here (velocity threshold, legato), which
        // is why `None` is passed for both. The internal pattern, once it exists, passes its own
        // explicit bits instead - see NoteMerger::note_on.
        let command = if event.kind == EVENT_NOTE_ON {
            Some(state.merger.note_on(event.id as u64, event.pitch as f64 + event.cent as f64 / 100.0,
                                      event.velocity, Source::Live, None, None))
        } else {
            state.merger.note_off(event.id as u64)
        };
        state.apply(command);
    }

    fn reset(state: &mut State) {
        // Transport stop: drop the held notes AND silence the voice. Clearing the merger alone
        // would leave the voice gated with no note to release it.
        state.merger.reset();
        state.voice.note_off();
    }
}

/// The adapter-derived mappings, separated from the id lookup so they can be tested without a host.
pub fn apply_slot(par: &mut crate::Params, slot: usize, value: ParamValue) {
    match slot {
            // The five acid knobs are `ValueMapping.unipolar()` in the adapter, which is exactly the
            // 0..1 the model's params already are, so they pass straight through.
            param::CUTOFF => par.cutoff = unit(value),
            param::RESONANCE => par.resonance = unit(value),
            param::ENV_MOD => par.envmod = unit(value),
            param::DECAY => par.decay = unit(value),
            param::ACCENT => par.accent = unit(value),
            // `ValueMapping.linear(-1200, 1200)` cents. The model's `tuning` is a 0..1 knob that it
            // converts with `(tuning - 0.5) * 24` semitones, i.e. +/-1200 cents across the range, so
            // the inverse is cents / 2400 + 0.5. Doing this here keeps the voice a verbatim
            // transcription: no unit conversion is allowed to leak into the calibrated code.
            param::TUNING => par.tuning = (real(value) as f64 / 2400.0 + 0.5).clamp(0.0, 1.0),
            // `ValueMapping.DefaultDecibel` delivers real dB; the model's `volume` is a linear gain.
            param::VOLUME => par.volume = libm::pow(10.0, real(value) as f64 / 20.0),
            // `ValueMapping.linearInteger(0, 1)`: 0 = Sawtooth, 1 = Square. The model selects on
            // `waveform < 0.5`.
            param::WAVEFORM => par.waveform = real(value) as f64,
            _ => {}
        }
    }


/// A `Unit` parameter: the uniform 0..1 automation value, used directly by the model's knobs.
fn unit(value: ParamValue) -> f64 {
    match value {
        ParamValue::Unit(unit) => unit as f64,
        ParamValue::Float(real) => real as f64,
        ParamValue::Int(real) => real as f64,
        ParamValue::Bool(flag) => if flag {1.0} else {0.0}
    }
}

/// A parameter carrying an already-real value (dB, cents, an enum index).
fn real(value: ParamValue) -> f32 {
    match value {
        ParamValue::Float(real) => real,
        ParamValue::Int(real) => real as f32,
        ParamValue::Unit(unit) => unit,
        ParamValue::Bool(flag) => if flag {1.0} else {0.0}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Params;

    /// Guards the conversions between the adapter's real-world units and the model's knobs. These
    /// are the only place the port is allowed to differ from the JS model, so they are the only
    /// place a unit error can hide.
    #[test]
    fn tuning_cents_map_onto_the_models_knob() {
        let mut par = Params::default();
        apply_slot(&mut par, param::TUNING, ParamValue::Float(0.0));
        assert_eq!(par.tuning, 0.5, "centre must be the model's neutral 0.5");
        // the model converts with (tuning - 0.5) * 24 semitones, so +1200 ct must land at +12
        apply_slot(&mut par, param::TUNING, ParamValue::Float(1200.0));
        assert!(((par.tuning - 0.5) * 24.0 - 12.0).abs() < 1e-9);
        apply_slot(&mut par, param::TUNING, ParamValue::Float(-1200.0));
        assert!(((par.tuning - 0.5) * 24.0 + 12.0).abs() < 1e-9);
    }

    #[test]
    fn volume_decibels_become_linear_gain() {
        let mut par = Params::default();
        apply_slot(&mut par, param::VOLUME, ParamValue::Float(0.0));
        assert!((par.volume - 1.0).abs() < 1e-9, "0 dB is unity, not 0");
        apply_slot(&mut par, param::VOLUME, ParamValue::Float(-6.0));
        assert!((par.volume - 0.5011872336272722).abs() < 1e-9);
    }

    #[test]
    fn waveform_index_selects_the_right_table() {
        let mut par = Params::default();
        apply_slot(&mut par, param::WAVEFORM, ParamValue::Int(0));
        assert!(par.waveform < 0.5, "0 = Sawtooth");
        apply_slot(&mut par, param::WAVEFORM, ParamValue::Int(1));
        assert!(par.waveform >= 0.5, "1 = Square");
    }

    #[test]
    fn the_acid_knobs_pass_through_unchanged() {
        let mut par = Params::default();
        for (slot, get) in [(param::CUTOFF, 0), (param::RESONANCE, 1), (param::ENV_MOD, 2),
                            (param::DECAY, 3), (param::ACCENT, 4)] {
            apply_slot(&mut par, slot, ParamValue::Unit(0.25));
            let actual = [par.cutoff, par.resonance, par.envmod, par.decay, par.accent][get];
            assert_eq!(actual, 0.25);
        }
    }
}
