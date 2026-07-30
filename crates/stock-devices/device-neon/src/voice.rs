//! One Neon voice: up to two LINES (per the line select), each a phase-distortion oscillator with its own
//! pitch / DCW / DCA 8-stage envelopes, combined plain, ring (line1 × line2 + line2) or noise (line 2's pitch
//! scrambled per cycle). Vibrato (delayed LFO) and glide act on the voice's base frequency. All live
//! parameters come from the shared [`NeonParams`] each chunk, so edits reach sounding voices.

use core::cell::RefCell;
use abi::{Block, EventRecord};
use dsp::glide::Glide;
use dsp::RENDER_QUANTUM;
use voicing::Voice;
use crate::envelope::{Envelope, EnvelopeSpec};
use crate::pd;

pub const MOD_NONE: i32 = 0;
pub const MOD_RING: i32 = 1;
pub const MOD_NOISE: i32 = 2;

/// One line's live configuration (waves, key follows, the three envelope specs).
pub struct LineConfig {
    pub wave1: i32,
    pub wave2: i32, // 0 = off, else panel wave index + 1
    pub dcw_key_follow: f32, // 0-9
    pub dca_key_follow: f32, // 0-9
    pub pitch_env: EnvelopeSpec,
    pub dcw_env: EnvelopeSpec,
    pub dca_env: EnvelopeSpec
}

impl Default for LineConfig {
    fn default() -> Self {
        Self {wave1: 0, wave2: 0, dcw_key_follow: 0.0, dca_key_follow: 0.0,
            pitch_env: EnvelopeSpec::flat(), dcw_env: EnvelopeSpec::flat(), dca_env: EnvelopeSpec::flat()}
    }
}

pub struct VibratoConfig {
    pub wave: i32, // 0 triangle, 1 saw up, 2 saw down, 3 square
    pub delay_seconds: f32,
    pub rate_hz: f32,
    pub depth_cents: f32
}

/// The shared per-chunk scratch: the gliding base frequency, filled once per window.
pub struct Workspace {
    freq: [f32; RENDER_QUANTUM]
}

impl Default for Workspace {
    fn default() -> Self {
        Self {freq: [0.0; RENDER_QUANTUM]}
    }
}

/// The device's live parameters (the voicing `Shared` type), mutated by `parameter_changed` / `field_changed`.
pub struct NeonParams {
    pub sample_rate: f32,
    pub line_select: i32, // 0 = 1, 1 = 2, 2 = 1+1', 3 = 1+2'
    pub modulation: i32,
    pub octave_multiplier: f32,
    pub detune_ratio: f32, // the primed line's frequency ratio
    pub vibrato: VibratoConfig,
    pub lines: [LineConfig; 2],
    pub workspace: RefCell<Workspace>
}

/// The sounding lines for a line-select value: (line-config index, detuned), second entry `None` for a
/// single line.
fn routing(line_select: i32) -> [(usize, bool); 2] {
    match line_select {
        1 => [(1, false), (usize::MAX, false)],
        2 => [(0, false), (0, true)],
        3 => [(0, false), (1, true)],
        _ => [(0, false), (usize::MAX, false)]
    }
}

fn lfo_value(wave: i32, phase: f32) -> f32 {
    match wave {
        1 => 2.0 * phase - 1.0,
        2 => 1.0 - 2.0 * phase,
        3 => if phase < 0.5 {1.0} else {-1.0},
        _ => if phase < 0.5 {4.0 * phase - 1.0} else {3.0 - 4.0 * phase}
    }
}

/// Raw DCA level 0-99 to a gain: the MEASURED VirtualCZ curve (sustained level ladder, dB re level 99),
/// linearly interpolated in dB. No closed-form law fits it (−3.3dB at 90 accelerating to −79dB at 10).
fn dca_gain(raw: f32) -> f32 {
    const POINTS: [(f32, f32); 11] = [
        (5.0, -103.4), (10.0, -79.3), (20.0, -55.4), (30.0, -41.4), (40.0, -31.4), (50.0, -23.7),
        (60.0, -17.3), (70.0, -12.0), (80.0, -7.4), (90.0, -3.3), (99.0, 0.0)
    ];
    if raw < 1.0 {
        return 0.0;
    }
    let value = raw.clamp(1.0, 99.0);
    let mut decibel = POINTS[0].1;
    for pair in POINTS.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if value <= x1 {
            decibel = if value <= x0 {y0} else {y0 + (y1 - y0) * (value - x0) / (x1 - x0)};
            break;
        }
        decibel = y1;
    }
    libm::powf(10.0, decibel / 20.0)
}

/// Raw DCW level 0-99 to the distortion amount 0..1: LINEAR, per the VirtualCZ DCW sweep probes (with
/// the corrected shape identities, raw 73 lands exactly at the w = 0.73 spectrum of each knee family).
fn dcw_amount(raw: f32) -> f32 {
    (raw / 99.0).clamp(0.0, 1.0)
}

/// Raw pitch-env level 0-99 to semitones: the MEASURED VirtualCZ table (sustained pitch ladder at env
/// depth 84). Piecewise linear with the hardware's region jumps (fine steps to 63, whole-tone zone
/// 64-70, slow zone to 93, top jump at 96).
fn pitch_semitones(raw: f32) -> f32 {
    const POINTS: [(f32, f32); 16] = [
        (0.0, 0.0), (5.0, 0.52), (10.0, 1.12), (20.0, 2.37), (33.0, 3.95), (45.0, 5.57), (55.0, 6.78),
        (63.0, 7.79), (64.0, 7.94), (67.0, 13.94), (70.0, 19.94), (80.0, 20.86), (90.0, 21.83),
        (93.0, 22.86), (96.0, 35.95), (99.0, 35.95)
    ];
    let value = raw.clamp(0.0, 99.0);
    let mut semitones = 0.0;
    for pair in POINTS.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if value <= x1 {
            semitones = y0 + (y1 - y0) * (value - x0) / (x1 - x0);
            break;
        }
        semitones = y1;
    }
    semitones
}

fn xorshift(state: &mut u32) -> f32 {
    let mut x = if *state == 0 {0x9E37_79B9} else {*state};
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    (x >> 8) as f32 / (1u32 << 24) as f32
}

#[derive(Clone, Copy, Default)]
struct LineVoice {
    phase: f32,
    second_wave: bool,
    noise_ratio: f32,
    pitch_env: Envelope,
    dcw_env: Envelope,
    dca_env: Envelope
}

pub struct NeonVoice {
    gate: bool,
    pending_release: bool,
    note: f32,
    glide: Glide,
    lines: [LineVoice; 2],
    vib_phase: f32,
    age_seconds: f32,
    rng: u32,
    sample_rate: f32
}

impl Default for NeonVoice {
    fn default() -> Self {
        Self {gate: false, pending_release: false, note: 0.0, glide: Glide::default(),
            lines: [LineVoice::default(); 2], vib_phase: 0.0, age_seconds: 0.0, rng: 0, sample_rate: 0.0}
    }
}

impl NeonVoice {
    fn process_window(&mut self, out_left: &mut [f32], out_right: &mut [f32], shared: &NeonParams, work: &mut Workspace) -> bool {
        let len = out_left.len();
        let sample_rate = shared.sample_rate;
        let dt = 1.0 / sample_rate;
        let route = routing(shared.line_select);
        let two_lines = route[1].0 != usize::MAX;
        if self.pending_release {
            self.pending_release = false;
            for (slot, (config_index, _)) in route.iter().enumerate() {
                if *config_index == usize::MAX {continue}
                let config = &shared.lines[*config_index];
                let line = &mut self.lines[slot];
                line.pitch_env.release(&config.pitch_env);
                line.dcw_env.release(&config.dcw_env);
                line.dca_env.release(&config.dca_env);
            }
        }
        let vibrato = &shared.vibrato;
        // Measured: key follow tracks the OCTAVE-SHIFTED pitch (note 72 at octave 0 ≡ note 60 at +1).
        let kf_note = self.note + libm::log2f(shared.octave_multiplier) * 12.0;
        for index in 0..len {
            self.age_seconds += dt;
            let ramp = if vibrato.depth_cents <= 0.0 {0.0} else {
                ((self.age_seconds - vibrato.delay_seconds) / 0.5).clamp(0.0, 1.0)
            };
            let vib_cents = if ramp > 0.0 {
                let value = lfo_value(vibrato.wave, self.vib_phase) * vibrato.depth_cents * ramp;
                self.vib_phase += vibrato.rate_hz * dt;
                if self.vib_phase >= 1.0 {self.vib_phase -= 1.0}
                value
            } else {
                self.vib_phase += vibrato.rate_hz * dt;
                if self.vib_phase >= 1.0 {self.vib_phase -= 1.0}
                0.0
            };
            let base = work.freq[index] * shared.octave_multiplier;
            let vib_ratio = if vib_cents != 0.0 {libm::exp2f(vib_cents / 1200.0)} else {1.0};
            let mut outs = [0.0f32; 2];
            let mut finished = true;
            for (slot, (config_index, detuned)) in route.iter().enumerate() {
                if *config_index == usize::MAX {continue}
                let config = &shared.lines[*config_index];
                let line = &mut self.lines[slot];
                let semis = pitch_semitones(line.pitch_env.process(&config.pitch_env, dt));
                let dcw_raw = line.dcw_env.process(&config.dcw_env, dt);
                // Measured on the VirtualCZ kf-dca decay ladder: the follow REFERENCES C2 (note 36) — at
                // kf 9 a C4 decay already runs 1.5× and C6 3.3×, while C2 matches kf 0 exactly.
                let dca_dt = dt * libm::exp2f(config.dca_key_follow / 9.0 * (kf_note - 36.0).max(0.0) * 0.026);
                let dca_raw = line.dca_env.process(&config.dca_env, dca_dt);
                finished &= line.dca_env.finished();
                // Measured on the VirtualCZ vibrato-scope probe (detuned pair + vibrato): the beat rate
                // stays CONSTANT — the LFO bends both lines together, on top of the detune.
                let mut frequency = base * vib_ratio * if *detuned {shared.detune_ratio} else {1.0};
                if semis != 0.0 {
                    frequency *= libm::exp2f(semis / 12.0);
                }
                if shared.modulation == MOD_NOISE && two_lines && slot == 1 {
                    frequency *= line.noise_ratio.max(0.0625);
                }
                line.phase += frequency * dt;
                if line.phase >= 1.0 {
                    line.phase -= libm::floorf(line.phase);
                    if config.wave2 > 0 {
                        line.second_wave = !line.second_wave;
                    }
                    line.noise_ratio = libm::exp2f(xorshift(&mut self.rng) * 4.0 - 2.0);
                }
                // Measured on the VirtualCZ pair probes (integer AND f/2 sub-grids, all pairs vs saw +
                // square/pulse cross-checks): each panel wave has a fixed ORIENTATION; the wave2 cycle
                // plays time-reversed exactly when the pair's orientations differ.
                let second = line.second_wave && config.wave2 > 0;
                let (wave, phase) = if second && pd::orientation(config.wave1) != pd::orientation(config.wave2 - 1) {
                    (config.wave2 - 1, 1.0 - line.phase)
                } else if second {
                    (config.wave2 - 1, line.phase)
                } else {
                    (config.wave1, line.phase)
                };
                // Measured on the VirtualCZ kf-dcw ladder: no effect at or below C4, C6 at kf 9 reads
                // like DCW ≈ 70/99 (≈ 0.013 amount per semitone above note 60).
                let follow = 1.0 - config.dcw_key_follow / 9.0 * (kf_note - 60.0).max(0.0) * 0.013;
                let amount = (dcw_amount(dcw_raw) * follow).clamp(0.0, 1.0);
                outs[slot] = pd::render(wave, phase, amount) * dca_gain(dca_raw);
            }
            if finished && !self.gate {
                return true;
            }
            let combined = if two_lines {
                // Measured on VirtualCZ (ring-sine probe): pure cosines at f and f/2 ring to EQUAL ±6dB
                // sidebands at 0.5f/1.5f over a full-level f component = line1 + line1 × line2.
                if shared.modulation == MOD_RING {outs[0] + outs[0] * outs[1]} else {outs[0] + outs[1]}
            } else {
                outs[0]
            };
            let sample = combined * 0.25;
            out_left[index] += sample;
            out_right[index] += sample;
        }
        false
    }
}

impl Voice for NeonVoice {
    type Shared = NeonParams;

    fn start(&mut self, event: &EventRecord, frequency: f32, _gain: f32, _spread: f32, _unison: usize, shared: &NeonParams) {
        self.gate = true;
        self.pending_release = false;
        self.note = event.pitch as f32;
        self.sample_rate = shared.sample_rate;
        self.glide = Glide::default();
        self.glide.init(frequency as f64);
        self.vib_phase = 0.0;
        self.age_seconds = 0.0;
        self.rng = event.id.wrapping_mul(747_796_405).wrapping_add(1);
        for line in self.lines.iter_mut() {
            line.phase = 0.0;
            line.second_wave = false;
            line.noise_ratio = 1.0;
            line.pitch_env.start();
            line.dcw_env.start();
            line.dca_env.start();
        }
    }

    fn stop(&mut self) {
        self.gate = false;
        self.pending_release = true;
    }

    fn force_stop(&mut self) {
        self.gate = false;
        self.pending_release = false;
        for line in self.lines.iter_mut() {
            line.pitch_env.force_finish();
            line.dcw_env.force_finish();
            line.dca_env.force_finish();
        }
    }

    fn start_glide(&mut self, target_frequency: f32, glide_duration: f64) {
        self.glide.glide_to(target_frequency as f64, glide_duration);
    }

    fn gate(&self) -> bool {
        self.gate
    }

    fn current_frequency(&self) -> f32 {
        self.glide.current_frequency() as f32
    }

    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &NeonParams) -> bool {
        let [out_left, out_right] = output;
        let mut work = shared.workspace.borrow_mut();
        let total = out_left.len();
        let mut base = 0;
        while base < total {
            let len = (total - base).min(RENDER_QUANTUM);
            for sample in &mut work.freq[..len] {
                *sample = 1.0;
            }
            self.glide.process(&mut work.freq, block.bpm, self.sample_rate, 0, len);
            if self.process_window(&mut out_left[base..base + len], &mut out_right[base..base + len], shared, &mut work) {
                return true;
            }
            base += len;
        }
        false
    }
}
