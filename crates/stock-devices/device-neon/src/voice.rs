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
    // Slope-continuous Catmull-Rom through the measured knots: piecewise-LINEAR interpolation kinked the
    // amplitude slope at every knot crossing, AM-ing decays with ±(knot-rate) sidebands (~23Hz on
    // mr-drummin, −34dB) that VirtualCZ's smooth curve does not have. Knot values stay exact.
    let mut decibel = POINTS[POINTS.len() - 1].1;
    for index in 0..POINTS.len() - 1 {
        let (x1, y1) = POINTS[index];
        let (x2, y2) = POINTS[index + 1];
        if value <= x2 {
            if value <= x1 && index == 0 {
                decibel = y1;
                break;
            }
            let (x0, y0) = if index == 0 {(x1, y1)} else {POINTS[index - 1]};
            let (x3, y3) = if index + 2 < POINTS.len() {POINTS[index + 2]} else {(x2, y2)};
            let tangent1 = (y2 - y0) / (x2 - x0).max(1.0e-6);
            let tangent2 = (y3 - y1) / (x3 - x1).max(1.0e-6);
            let width = x2 - x1;
            let t = ((value - x1) / width).clamp(0.0, 1.0);
            let t2 = t * t;
            let t3 = t2 * t;
            decibel = (2.0 * t3 - 3.0 * t2 + 1.0) * y1
                + (t3 - 2.0 * t2 + t) * tangent1 * width
                + (-2.0 * t3 + 3.0 * t2) * y2
                + (t3 - t2) * tangent2 * width;
            break;
        }
    }
    libm::powf(10.0, decibel / 20.0)
}

/// Raw DCW level 0-99 to the distortion amount 0..1: LINEAR, per the VirtualCZ DCW sweep probes (with
/// the corrected shape identities, raw 73 lands exactly at the w = 0.73 spectrum of each knee family).
fn dcw_amount(raw: f32) -> f32 {
    (raw / 99.0).clamp(0.0, 1.0)
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
    noise_clock: u32,
    pitch_env: Envelope,
    dcw_env: Envelope,
    dca_env: Envelope
}

pub struct NeonVoice {
    gate: bool,
    dcw_amount0: f32, // line 1's live dcw amount (gates the noise product)
    dca_gain0: f32, // line 1's dca gain: scales the additive noise
    pending_release: bool,
    dying: bool, // force-stopped: keep rendering through a short output fade instead of cutting
    fade: f32,
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
        Self {gate: false, dcw_amount0: 0.0, dca_gain0: 0.0, pending_release: false, dying: false, fade: 1.0, note: 0.0, glide: Glide::default(),
            lines: [LineVoice::default(); 2], vib_phase: 0.0, age_seconds: 0.0, rng: 0, sample_rate: 0.0}
    }
}

const FORCE_STOP_FADE_SECONDS: f32 = 0.003; // the vapo VCA smoother's time constant
const FADE_SILENCE: f32 = 1.0e-4; // −80dB: the fade is done

impl NeonVoice {
    /// The envelope playheads for the editor broadcast: (position, level) per envelope in the box
    /// order (line1 pitch/DCW/DCA, line2 …), -1 positions for lines the current routing leaves silent.
    pub fn env_positions(&self, shared: &NeonParams, out: &mut [f32]) {
        let route = routing(shared.line_select);
        for config_index in 0..2usize {
            let base = config_index * 6;
            match route.iter().position(|(index, _)| *index == config_index) {
                Some(slot) => {
                    let line = &self.lines[slot];
                    let config = &shared.lines[config_index];
                    let (pitch_pos, pitch_level) = line.pitch_env.ui_position(&config.pitch_env, true);
                    let (dcw_pos, dcw_level) = line.dcw_env.ui_position(&config.dcw_env, false);
                    let (dca_pos, dca_level) = line.dca_env.ui_position(&config.dca_env, false);
                    out[base] = pitch_pos;
                    out[base + 1] = pitch_level;
                    out[base + 2] = dcw_pos;
                    out[base + 3] = dcw_level;
                    out[base + 4] = dca_pos;
                    out[base + 5] = dca_level;
                }
                None => {
                    out[base..base + 6].fill(-1.0);
                }
            }
        }
    }

    fn process_window(&mut self, out_left: &mut [f32], out_right: &mut [f32], shared: &NeonParams, work: &mut Workspace) -> bool {
        let len = out_left.len();
        let sample_rate = shared.sample_rate;
        let dt = 1.0 / sample_rate;
        let fade_coeff = if self.dying {libm::expf(-1.0 / (FORCE_STOP_FADE_SECONDS * sample_rate.max(1.0)))} else {1.0};
        let noise_period: u32 = option_env!("NEON_NOISE_CLOCK").and_then(|value| value.parse().ok()).unwrap_or(8);
        let noise_jump: f32 = option_env!("NEON_NOISE_JUMP").and_then(|value| value.parse().ok()).unwrap_or(32.0);
        let noise_ratio_high = libm::exp2f(noise_jump / 12.0);
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
                // A line-select edit can route a slot in AFTER note-off (its envelopes were never
                // released): without this the slot plays its attack and SUSTAINS forever — the voice
                // never finishes. Release any active slot the moment the gate is off.
                if !self.gate && !self.pending_release && !line.dca_env.is_released() {
                    line.pitch_env.release(&config.pitch_env);
                    line.dcw_env.release(&config.dcw_env);
                    line.dca_env.release(&config.dca_env);
                }
                let semis = line.pitch_env.process_pitch(&config.pitch_env, dt);
                let dcw_raw = line.dcw_env.process_dcw(&config.dcw_env, dt);
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
                    // Measured on the VirtualCZ note ladder (36..84): the noise spectrum PEAKS ~2-3× the
                    // note with a steep low-side rolloff — the random pitch ratio only goes UP from the
                    // note (log-uniform, ~2.8 octaves), never below it. Reseeding happens per CYCLE only
                    // (the wrap below): any mid-cycle re-clock smears the harmonics into broadband mids
                    // the reference does not have (mr-drummin burst bands).
                    // The HARDWARE noise law (uPD933: "pitch modulated by noise — 0 or 32 semitones
                    // above base pitch", re-rolled every 8 samples): a BINARY pitch jump whose fast
                    // switching also supplies the sideband skirt/hiss the earlier continuous
                    // per-cycle model lacked.
                    line.noise_clock = line.noise_clock.wrapping_add(1);
                    if line.noise_clock >= noise_period {
                        line.noise_clock = 0;
                        line.noise_ratio = if xorshift(&mut self.rng) < 0.5 {1.0} else {noise_ratio_high};
                    }
                    frequency *= line.noise_ratio.max(1.0);
                }
                line.phase += frequency * dt;
                if line.phase >= 1.0 {
                    line.phase -= libm::floorf(line.phase);
                    if config.wave2 > 0 {
                        line.second_wave = !line.second_wave;
                    }
                }
                // Measured on the VirtualCZ pair probes (integer AND f/2 sub-grids, all pairs vs saw +
                // square/pulse cross-checks): each panel wave has a fixed ORIENTATION; the wave2 cycle
                // plays time-reversed exactly when the pair's orientations differ.
                let second = line.second_wave && config.wave2 > 0;
                // Measured on the VirtualCZ kf-dcw harmonic ladder (36/48/55/60): the follow acts
                // continuously from C2 like the DCA follow — C6 at kf 9 reads like DCW ≈ 70/99
                // (≈ 0.00625 amount per semitone above note 36).
                let follow = 1.0 - config.dcw_key_follow / 9.0 * (kf_note - 36.0).max(0.0) * 0.00625;
                let amount = (dcw_amount(dcw_raw) * follow).clamp(0.0, 1.0);
                if slot == 0 {
                    self.dcw_amount0 = amount;
                }
                // SOLO waves are PERIOD-1 (uPD933 firmware: wave[1] = wave[0]; kasploosh "010+010 = 010";
                // melodiblock hardware preview). The earlier period-2 "implicit saw pair" family was a
                // probe-harness artifact: VirtualCZ's shape_b has no off state and DEFAULTS TO SAW.
                let (wave, phase, cycle_amount) = if second && pd::orientation(config.wave1) != pd::orientation(config.wave2 - 1) {
                    (config.wave2 - 1, 1.0 - line.phase, amount)
                } else if second {
                    (config.wave2 - 1, line.phase, amount)
                } else {
                    (config.wave1, line.phase, amount)
                };
                // The noise modulator needs NO special gain path: the measured VirtualCZ behaviors
                // (aeg2 ladder = the normal dca curve; the drummin falling burst; the end cut) all
                // fall out of the one-shot ascending-end-stage drain rule in envelope.rs.
                let gain = dca_gain(dca_raw);
                outs[slot] = pd::render(wave, phase, cycle_amount, frequency / 261.63) * gain;
                if slot == 0 {
                    self.dca_gain0 = gain;
                }
            }
            if finished && !self.gate {
                return true;
            }
            let combined = if two_lines {
                // Measured on VirtualCZ (ring-sine probe): pure cosines at f and f/2 ring to EQUAL ±6dB
                // sidebands at 0.5f/1.5f over a full-level f component = line1 + line1 × line2.
                // NOISE is ring modulation with a noise source (the manual's own definition): the
                // noise-clocked line multiplies line 1 as a MODULATOR — summing it as an audible voice
                // drowned patches in noise the hardware only uses as texture.
                if shared.modulation == MOD_NOISE {
                    let mix: f32 = option_env!("NEON_NOISE_MIX").and_then(|value| value.parse().ok()).unwrap_or(0.95);
                    // ADDITIVE noise scaled by the carrier's DCA gain (battery-proven vs the product:
                    // VirtualCZ's noise spectrum is independent of the carrier's DCW — a product with a
                    // dull carrier collapsed 15dB by 700Hz; level still tracks the dca_gain ladder).
                    outs[0] + outs[1] * self.dca_gain0 * mix
                } else if shared.modulation == MOD_RING {
                    outs[0] + outs[0] * outs[1]
                } else {
                    outs[0] + outs[1]
                }
            } else {
                outs[0]
            };
            let sample = combined * 0.25 * self.fade;
            out_left[index] += sample;
            out_right[index] += sample;
            if self.dying {
                self.fade *= fade_coeff;
                if self.fade < FADE_SILENCE {
                    return true;
                }
            }
        }
        false
    }
}

impl Voice for NeonVoice {
    type Shared = NeonParams;

    fn start(&mut self, event: &EventRecord, frequency: f32, _gain: f32, _spread: f32, _unison: usize, shared: &NeonParams) {
        self.gate = true;
        self.pending_release = false;
        self.dying = false;
        self.fade = 1.0;
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
            line.noise_clock = 0;
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
        self.dying = true;
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
