//! Real-time monophonic pitch CORRECTION control core: detects the input's fundamental (YIN on a
//! 2:1-decimated mono mix), snaps it to the nearest allowed note of a key/scale mask,
//! stabilises the decision (35-cent hysteresis — skipped in chromatic — + a 120ms one-pole pitch centre), scales the correction by
//! `amount`, glides it through a one-pole whose time constant comes from `retune`, and composes the manual
//! `shift` on top. The result (`current_semitones`) drives the PSOLA shifter (`Psola`); this core
//! produces CONTROL only, it never touches the audio path. Zero-allocation by
//! design (devices own no heap): all state is fixed arrays sized for the 44.1/48k design point.
//!
//! DETERMINISM: every DECISION (which note to snap to) is computed in f64 with pinned rounding
//! points and deterministic tie-breaks, so the note sequence for a given input is reproducible —
//! the golden-fixture test below pins it against regressions.

const DECIMATION: usize = 2; // box-average pairs: detection runs at sample_rate / 2
const RING_SIZE: usize = 2048;
const RING_MASK: u32 = (RING_SIZE - 1) as u32;
// Window/hop are kept SMALL to minimise detection latency — the correction is feedforward, so any lag
// between the true pitch and the detected pitch leaves residual wobble that `smooth` cannot cancel. 640
// gives ~13ms centre latency (vs 21ms at 1024) and still spans ~2 periods at the 80 Hz floor.
const WINDOW: usize = 640; // YIN analysis window (decimated samples)
const TAU_MAX: usize = 300; // max lag: f0 floor = detect_rate / 300 (80 Hz at 48k native)
const SPAN: usize = WINDOW + TAU_MAX;
const HOP: usize = 128; // decimated samples per detection frame (~5.3ms at 48k native) — fast correction updates
const YIN_THRESHOLD: f64 = 0.15;
const CLARITY_MAX: f64 = 0.15; // voiced requires the chosen dip's CMNDF below this
const TUNER_CLARITY_MAX: f64 = 0.5; // looser gate for the TUNER display: show a pitch even when correction won't engage
const RMS_FLOOR: f64 = 1.7782794e-3; // -55 dBFS
const F0_MIN_HZ: f64 = 80.0;
const F0_MAX_HZ: f64 = 1100.0;
// Note selection tracks a SMOOTHED pitch (the sung centre), not the instantaneous pitch — otherwise
// vibrato that crosses a scale-note boundary makes the target flip notes every cycle (audible warble).
const NOTE_TAU_SECONDS: f64 = 0.120; // pitch-centre smoothing: averages out ~5 Hz vibrato, still tracks real note changes
const OCTAVE_CLAMP_SEMITONES: f64 = 6.0; // the correction never moves the pitch more than a half-octave: stays in the current octave
const DEADBAND_SEMITONES: f64 = 0.35; // hysteresis: a new note must be 35 cents closer to the centre to win
const TAU_SLOW_SECONDS: f64 = 0.500; // retune = 0: slow, gentle glide to a new note
const TAU_FAST_SECONDS: f64 = 0.002; // retune = 1: near-instant note changes
// `smooth` is an EXTRA one-pole low-pass on the NOTE path only: cascaded after the retune glide it rounds
// note changes into an S-curve (smooth retune) and damps detection jitter. It does NOT touch the
// vibrato-flatten path — that is applied after the filters, so flattening works at any smooth setting.
const SMOOTH_MAX_TAU_SECONDS: f64 = 0.300; // smooth = 1: heavily damped, rock-steady note transitions
// The vibrato-flatten term is applied OUTSIDE the retune/smooth one-poles (they would low-pass the ~5Hz
// anti-vibrato modulation away), and DELAYED one frame so it lines up with the audio the shifter emits.
// Empirically swept 0..4 on a 5.5Hz ±34c vibrato tone through core+PSOLA (see the ignored sweep test):
// residual 5.9/3.8/4.7/8.7/11.9 cents RMS for delays 0..4 — 1 frame wins (latency arithmetic predicted
// 2-3; the PSOLA nearest-mark grain selection eats most of the expected lead).
const FLATTEN_DELAY_FRAMES: usize = 1;
const DEVIATION_RING: usize = 8;
// The flatten term only cancels VIBRATO, so bound the deviation it acts on to a vibrato-sized range. Note
// changes and detector octave-wobble make `folded - m_slow` swing up to the ±6 octave-fold limit; without
// this cap, at hardness 1 that drives the shift ratio ±6 st with ~octave frame-to-frame jumps, and BOTH
// shifters render those spikes as period-doubled/octave-collapse bursts. Large moves belong to the note
// path (target − m_slow), which glides smoothly; the flatten must not chase them.
const FLATTEN_MAX_DEVIATION: f64 = 1.5;
const VOICED_DEBOUNCE: usize = 2; // consecutive voiced frames to engage
const HANGOVER_FRAMES: usize = 8; // frames the target survives a momentary clarity loss (~85ms)
const A4_HZ: f64 = 440.0;
const MIDI_REF: f64 = 69.0;
const SEARCH_SEMITONES: i32 = 7; // snap search radius; every mask has bit 0, so ±7 always hits
const SMOOTHED_SNAP_EPSILON: f64 = 1.0e-4; // pull the one-pole residual to exactly 0 for a bit-exact dry

// Root-relative 12-bit pitch-class masks, indexed EXACTLY like the adapter's scale list:
// 0 Chrom, 1 Major, 2 Minor, 3 MajPent, 4 MinPent, 5 Blues, 6 Dorian, 7 Mixo. Bit 0 (the root) is
// always set, so a nearest allowed note always exists.
pub const SCALE_MASKS: [u32; 8] = [0xFFF, 0xAB5, 0x5AD, 0x295, 0x4A9, 0x4E9, 0x6AD, 0x6B5];

pub struct Autotune {
    ring: [f32; RING_SIZE],
    scratch: [f32; SPAN],
    dprime: [f64; TAU_MAX + 1],
    write: u32,
    filled: bool,
    hop_count: usize,
    pending: f32,
    has_pending: bool,
    detect_rate: f64,
    frame_seconds: f64,
    note_alpha: f64,
    tau_min: usize,
    key: i32,
    mask: u32,
    amount: f64,
    retune_tau: f64,
    hardness: f64,
    smooth: f64,
    shift: f64,
    m_slow: f64,
    prev_target: i32,
    voiced_run: usize,
    hangover: usize,
    engaged: bool,
    frame_voiced: bool,
    note_target: f64,
    note_glide: f64,
    correction: f64,
    last_f0: f64,
    inst_period: f64,
    deviation_ring: [f64; DEVIATION_RING],
    deviation_head: usize,
    flatten_delay: usize,
    flatten: f64,
}

impl Autotune {
    /// Initialise in place (the state lives in an engine-allocated block; a by-value constructor
    /// would put the ~17KB of arrays on the device's small stack).
    pub fn prepare(&mut self, sample_rate: f32) {
        self.detect_rate = sample_rate as f64 / DECIMATION as f64;
        self.frame_seconds = (HOP * DECIMATION) as f64 / sample_rate as f64;
        self.note_alpha = 1.0 - libm::exp(-self.frame_seconds / NOTE_TAU_SECONDS);
        let tau_min = libm::floor(self.detect_rate / F0_MAX_HZ) as usize;
        self.tau_min = math::clamp(tau_min, 2, TAU_MAX - 2);
        self.key = 0;
        self.mask = SCALE_MASKS[1];
        self.amount = 1.0;
        self.retune_tau = Self::retune_to_tau(0.50);
        self.hardness = 0.50;
        self.flatten_delay = FLATTEN_DELAY_FRAMES;
        self.smooth = 0.60;
        self.shift = 0.0;
        self.reset();
    }

    pub fn set_key(&mut self, key: i32) {self.key = math::clamp(key, 0, 11)}

    pub fn set_scale(&mut self, scale: i32) {self.mask = SCALE_MASKS[math::clamp(scale, 0, 7) as usize]}

    /// Correction depth. The knob is SQUARE-LAW tapered — the stored depth is `knob²` — so the lower half
    /// of the travel gives fine, gradual control over light correction (where an in-tune voice actually
    /// sits), while 100% still reaches full strength. 0 and 1 are unchanged fixed points.
    pub fn set_amount(&mut self, amount: f32) {
        let knob = math::clamp(amount as f64, 0.0, 1.0);
        self.amount = knob * knob;
    }

    /// Retune spans natural → hard-tune. Low = a slow, gentle glide that keeps the sung vibrato; high =
    /// a near-instant glide that also flattens the vibrato onto the grid note (the robotic auto-tune
    /// sound). One knob controls both the glide speed (`retune_tau`) and the flatten depth (`hardness`).
    pub fn set_retune(&mut self, retune: f32) {
        let retune = math::clamp(retune as f64, 0.0, 1.0);
        self.retune_tau = Self::retune_to_tau(retune);
        self.hardness = retune;
    }

    /// How steady the correction is held: 0 = responsive, 1 = heavily damped so the pitch-shift ratio
    /// barely moves (no audible speeding up / down). Does NOT remove sung vibrato — it only smooths the
    /// CORRECTION. Independent of retune (which sets the note-change glide speed).
    pub fn set_smooth(&mut self, smooth: f32) {self.smooth = math::clamp(smooth as f64, 0.0, 1.0)}

    pub fn set_shift(&mut self, shift: f32) {self.shift = shift as f64}

    /// The semitone offset the shifter should apply right now: the smoothed note correction minus the
    /// vibrato-flatten term (octave-bounded), scaled by `amount`, plus the manual `shift`.
    pub fn current_semitones(&self) -> f32 {
        let corrected = math::clamp(self.correction - self.flatten, -OCTAVE_CLAMP_SEMITONES, OCTAVE_CLAMP_SEMITONES);
        (self.amount * corrected + self.shift) as f32
    }

    /// The input's current fundamental period in NATIVE samples, from the INSTANTANEOUS detected pitch
    /// (octave-folded toward the centre to reject detector slips). PSOLA must place its analysis grains on
    /// the input's ACTUAL periods — feeding the smoothed centre here misplaces the grains whenever the
    /// pitch moves (vibrato/slides), which smears the overlap-add (warble). Falls back to 220 Hz before
    /// the first detection.
    pub fn current_period_samples(&self) -> f32 {
        let sample_rate = self.detect_rate * DECIMATION as f64;
        if self.engaged && self.inst_period > 0.0 {self.inst_period as f32} else {(sample_rate / 220.0) as f32}
    }

    /// Tuner telemetry — the detected pitch as a fractional MIDI note (0 before the first detection).
    pub fn detected_midi(&self) -> f32 {
        if self.last_f0 > 0.0 {(MIDI_REF + 12.0 * libm::log2(self.last_f0 / A4_HZ)) as f32} else {0.0}
    }

    /// Tuner telemetry — the note the pitch is being corrected TO (−1 before the first detection).
    pub fn target_note(&self) -> f32 {self.prev_target as f32}

    /// Tuner telemetry — whether a pitch is currently being tracked (a note is sounding). Uses the
    /// looser per-frame gate so the tuner shows the sung note even when the CORRECTION won't engage.
    pub fn is_voiced(&self) -> bool {self.frame_voiced}

    pub fn reset(&mut self) {
        self.ring.fill(0.0);
        self.scratch.fill(0.0);
        self.dprime.fill(0.0);
        self.write = 0;
        self.filled = false;
        self.hop_count = 0;
        self.pending = 0.0;
        self.has_pending = false;
        self.m_slow = 0.0;
        self.prev_target = -1;
        self.voiced_run = 0;
        self.hangover = 0;
        self.engaged = false;
        self.frame_voiced = false;
        self.note_target = 0.0;
        self.note_glide = 0.0;
        self.correction = 0.0;
        self.last_f0 = 0.0;
        self.inst_period = 0.0;
        self.deviation_ring.fill(0.0);
        self.deviation_head = 0;
        self.flatten = 0.0;
    }

    /// Test-only window into the last detection frame: (detected f0, chosen target note, engaged).
    #[cfg(test)]
    pub fn probe(&self) -> (f64, i32, bool) {(self.last_f0, self.prev_target, self.engaged)}

    /// Ingest one block of the (pre-shift) input and run any due detection frames. Rounding points
    /// are pinned for parity: mono and the decimated pair are computed in f64 and stored as f32.
    pub fn feed(&mut self, in_left: &[f32], in_right: &[f32], from: usize, to: usize) {
        for index in from..to {
            let mono = ((in_left[index] as f64 + in_right[index] as f64) * 0.5) as f32;
            if self.has_pending {
                let decimated = ((self.pending as f64 + mono as f64) * 0.5) as f32;
                self.has_pending = false;
                self.push(decimated);
            } else {
                self.pending = mono;
                self.has_pending = true;
            }
        }
    }

    /// The stabilised note decision for one detected pitch `m` (fractional MIDI). The target is snapped
    /// from a SMOOTHED pitch (`m_slow`, the sung centre) rather than the instantaneous pitch, so vibrato
    /// crossing a scale-note boundary does not flip the target every cycle; `DEADBAND` hysteresis holds
    /// the current note until the centre moves decisively toward a neighbour (skipped in chromatic, which
    /// always snaps to the nearest semitone), and the octave FOLD below pulls detector octave slips back
    /// to the current octave. Public so the golden fixture can drive it.
    pub fn decide(&mut self, m: f64) -> i32 {
        // Octave FOLD: a detected pitch more than a half-octave from the running centre is folded by
        // whole octaves back toward it. This corrects the detector's octave slips AND keeps all pitch
        // movement inside the current octave (a genuine octave leap is deliberately not followed).
        let mut folded = m;
        if self.prev_target >= 0 {
            while folded - self.m_slow > 6.0 {folded -= 12.0;}
            while folded - self.m_slow < -6.0 {folded += 12.0;}
            self.m_slow += (folded - self.m_slow) * self.note_alpha;
        } else {
            self.m_slow = folded;
        }
        let raw = self.nearest_allowed(self.m_slow);
        // The hysteresis is for scales whose note boundaries the centre can hover on. In CHROMATIC mode
        // every semitone is a target and boundaries sit at 50 cents; the deadband would keep pulling
        // toward the PREVIOUS semitone until the centre is 67.5 cents past it — audibly not the nearest
        // note. Chromatic therefore always snaps nearest; vibrato stability still comes from `m_slow`.
        let chromatic = self.mask == SCALE_MASKS[0];
        let chosen = if !chromatic && self.prev_target >= 0 && raw != self.prev_target && self.allowed(self.prev_target) {
            let keep = libm::fabs(self.m_slow - self.prev_target as f64) - libm::fabs(self.m_slow - raw as f64) <= DEADBAND_SEMITONES;
            if keep {self.prev_target} else {raw}
        } else {
            raw
        };
        // On a note change, jump the vibrato reference with the note: `m_slow` otherwise catches up at
        // NOTE_TAU and the step reads as deviation, which the flatten would chase (the hard-retune
        // settle defect). The intra-note offset is preserved; only the note delta is skipped.
        if self.prev_target >= 0 && chosen != self.prev_target {
            self.m_slow += (chosen - self.prev_target) as f64;
        }
        self.prev_target = chosen;
        chosen
    }

    fn retune_to_tau(retune: f64) -> f64 {
        TAU_SLOW_SECONDS * libm::pow(TAU_FAST_SECONDS / TAU_SLOW_SECONDS, retune)
    }

    fn allowed(&self, note: i32) -> bool {
        let pitch_class = ((note % 12) + 12) % 12;
        let relative = ((pitch_class - self.key) % 12 + 12) % 12;
        (self.mask >> relative) & 1 == 1
    }

    fn nearest_allowed(&self, m: f64) -> i32 {
        let base = libm::round(m) as i32;
        let mut best = i32::MIN;
        let mut best_distance = f64::INFINITY;
        for candidate in (base - SEARCH_SEMITONES)..=(base + SEARCH_SEMITONES) {
            if !self.allowed(candidate) {continue}
            let distance = libm::fabs(m - candidate as f64);
            if distance < best_distance - 1.0e-6 {
                best = candidate;
                best_distance = distance;
            } else if libm::fabs(distance - best_distance) <= 1.0e-6 && candidate == self.prev_target {
                best = candidate;
                best_distance = distance;
            }
        }
        best
    }

    fn push(&mut self, decimated: f32) {
        self.ring[(self.write & RING_MASK) as usize] = decimated;
        self.write = self.write.wrapping_add(1);
        if !self.filled && self.write as usize >= SPAN {self.filled = true}
        self.hop_count += 1;
        if self.hop_count >= HOP {
            self.hop_count -= HOP;
            if self.filled {self.frame()}
        }
    }

    fn frame(&mut self) {
        let start = self.write.wrapping_sub(SPAN as u32);
        for index in 0..SPAN {
            self.scratch[index] = self.ring[(start.wrapping_add(index as u32) & RING_MASK) as usize];
        }
        let mut energy = 0.0f64;
        for index in 0..SPAN {
            let sample = self.scratch[index] as f64;
            energy += sample * sample;
        }
        let rms = libm::sqrt(energy / SPAN as f64);
        let mut running = 0.0f64;
        self.dprime[0] = 1.0;
        for tau in 1..=TAU_MAX {
            let mut acc = 0.0f64;
            for index in 0..WINDOW {
                let difference = self.scratch[index] as f64 - self.scratch[index + tau] as f64;
                acc += difference * difference;
            }
            running += acc;
            self.dprime[tau] = if running > 0.0 {acc * tau as f64 / running} else {1.0};
        }
        let mut best_tau = 0usize;
        for tau in self.tau_min..TAU_MAX {
            if self.dprime[tau] < YIN_THRESHOLD
                && self.dprime[tau] <= self.dprime[tau - 1]
                && self.dprime[tau] <= self.dprime[tau + 1] {
                best_tau = tau;
                break;
            }
        }
        if best_tau == 0 {
            let mut minimum = f64::INFINITY;
            for tau in self.tau_min..TAU_MAX {
                if self.dprime[tau] < minimum {
                    minimum = self.dprime[tau];
                    best_tau = tau;
                }
            }
        }
        let clarity = self.dprime[best_tau];
        let below = self.dprime[best_tau - 1];
        let above = self.dprime[best_tau + 1];
        let denominator = below - 2.0 * clarity + above;
        let delta = if libm::fabs(denominator) > 1.0e-12 {
            math::clamp(0.5 * (below - above) / denominator, -0.5, 0.5)
        } else {
            0.0
        };
        let period = best_tau as f64 + delta;
        let f0 = self.detect_rate / period;
        self.last_f0 = f0;
        let in_band = f0.is_finite() && f0 >= F0_MIN_HZ && f0 <= F0_MAX_HZ && rms > RMS_FLOOR;
        self.frame_voiced = in_band && clarity < TUNER_CLARITY_MAX;
        let voiced = in_band && clarity < CLARITY_MAX;
        let mut deviation_now = 0.0f64;
        if voiced {
            self.voiced_run += 1;
            self.hangover = 0;
            if !self.engaged && self.voiced_run >= VOICED_DEBOUNCE {
                self.engaged = true;
                self.prev_target = -1; // decide() re-seeds m_slow from the first engaged pitch
            }
            if self.engaged {
                let m = MIDI_REF + 12.0 * libm::log2(f0 / A4_HZ);
                let target = self.decide(m);
                let mut folded = m;
                while folded - self.m_slow > 6.0 {folded -= 12.0;}
                while folded - self.m_slow < -6.0 {folded += 12.0;}
                // The note path carries ONLY the note offset (target vs the sung centre); it is glided by
                // retune and rounded by smooth below — their cascade makes note changes S-curved, not
                // stepped. The vibrato deviation is handled on a SEPARATE path (ring + flatten, after the
                // filters) so neither knob can low-pass the anti-vibrato modulation away.
                deviation_now = math::clamp(folded - self.m_slow, -FLATTEN_MAX_DEVIATION, FLATTEN_MAX_DEVIATION);
                self.note_target = target as f64 - self.m_slow;
                // The shifter's analysis period tracks the INSTANTANEOUS pitch (folded into the centre's
                // octave to drop detector slips), so grains sit on the real waveform periods even under
                // vibrato/slides — the smoothed centre would misplace them and smear the overlap-add.
                let hz = A4_HZ * libm::exp2((folded - MIDI_REF) / 12.0);
                self.inst_period = self.detect_rate * DECIMATION as f64 / hz;
            }
        } else {
            self.voiced_run = 0;
            if self.engaged {
                self.hangover += 1;
                if self.hangover > HANGOVER_FRAMES {self.engaged = false;}
            }
            if !self.engaged {self.note_target = 0.0;}
        }
        // Retune glides the note offset on note changes; smooth then damps the whole correction so the
        // ratio stays steady; finally clamp to keep the pitch inside the current octave.
        let retune_alpha = math::clamp(1.0 - libm::exp(-self.frame_seconds / self.retune_tau), 0.0, 1.0);
        self.note_glide += (self.note_target - self.note_glide) * retune_alpha;
        let smooth_tau = self.smooth * self.smooth * SMOOTH_MAX_TAU_SECONDS;
        let smooth_alpha = if smooth_tau > 0.0 {
            math::clamp(1.0 - libm::exp(-self.frame_seconds / smooth_tau), 0.0, 1.0)
        } else {
            1.0
        };
        self.correction += (self.note_glide - self.correction) * smooth_alpha;
        self.correction = math::clamp(self.correction, -OCTAVE_CLAMP_SEMITONES, OCTAVE_CLAMP_SEMITONES);
        if self.note_target == 0.0 && libm::fabs(self.correction) < SMOOTHED_SNAP_EPSILON {
            self.note_glide = 0.0;
            self.correction = 0.0;
        }
        // Vibrato-flatten path: scaled by hardness, delayed to meet the shifter's output timing, applied
        // outside the one-poles (see FLATTEN_DELAY_FRAMES). Unvoiced frames push 0 so it dies out quickly.
        self.deviation_ring[self.deviation_head] = deviation_now;
        self.deviation_head = (self.deviation_head + 1) % DEVIATION_RING;
        let delayed = self.deviation_ring[(self.deviation_head + DEVIATION_RING - 1 - self.flatten_delay) % DEVIATION_RING];
        // The flatten cancels VIBRATO only: while the glide is still travelling to a new note the
        // deviation is transition, not vibrato, and chasing it fights the retune (measured: step settle
        // WORSENED with higher retune). Fade the flatten in with glide settledness instead.
        let settle = 1.0 - math::clamp(libm::fabs(self.note_target - self.note_glide) / 0.5, 0.0, 1.0);
        self.flatten = self.hardness * delayed * settle;
    }
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;
    use math::PI;
    use alloc::boxed::Box;
    use alloc::vec;
    use alloc::vec::Vec;

    fn make(sample_rate: f32) -> Box<Autotune> {
        let mut core: Box<Autotune> = unsafe { Box::new(core::mem::zeroed()) };
        core.prepare(sample_rate);
        core
    }

    fn feed_sine(core: &mut Autotune, frequency: f32, sample_rate: f32, frames: usize) {
        let samples: Vec<f32> = (0..frames)
            .map(|index| 0.5 * libm::sinf(2.0 * PI * frequency * index as f32 / sample_rate))
            .collect();
        core.feed(&samples, &samples, 0, frames);
    }

    #[test]
    fn masks_match_their_interval_lists() {
        let intervals: [&[i32]; 8] = [
            &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            &[0, 2, 4, 5, 7, 9, 11],
            &[0, 2, 3, 5, 7, 8, 10],
            &[0, 2, 4, 7, 9],
            &[0, 3, 5, 7, 10],
            &[0, 3, 5, 6, 7, 10],
            &[0, 2, 3, 5, 7, 9, 10],
            &[0, 2, 4, 5, 7, 9, 10],
        ];
        for (scale, list) in intervals.iter().enumerate() {
            for pitch_class in 0..12 {
                let expected = list.contains(&pitch_class);
                let actual = (SCALE_MASKS[scale] >> pitch_class) & 1 == 1;
                assert_eq!(actual, expected, "scale {scale} pc {pitch_class}");
            }
        }
    }

    #[test]
    fn golden_decision_sequence() {
        // Golden fixture pinning the note-decision behavior against regressions.
        // (1) NOTE STABILITY: a vibrato whose instantaneous pitch crosses the C/C# boundary (60.5) must
        // NOT flip the note — the sung centre (60.3) sits below the boundary, so the target holds at C(60).
        let mut core = make(48_000.0);
        core.set_key(0);
        core.set_scale(0); // chromatic: every semitone allowed, so the boundary is purely the 0.5 mark
        let vibrato = [60.3, 60.8, 59.9, 60.8, 59.9, 60.8, 59.9, 60.8, 59.9, 60.8, 59.9, 60.8];
        for m in vibrato {
            assert_eq!(core.decide(m), 60, "vibrato must not flip the note (m {m})");
        }
        // (2) REAL NOTE CHANGE: a sustained move to 64 eventually re-targets (the smoothing tracks it).
        let mut moved = 60;
        for _ in 0..200 {moved = core.decide(64.0);}
        assert_eq!(moved, 64, "a sustained pitch move re-targets after the smoothing catches up");
        // (3) EXACT TIE breaks to the lower note (deterministic across engines).
        let mut tie = make(48_000.0);
        tie.set_key(0);
        tie.set_scale(1);
        assert_eq!(tie.decide(61.0), 60, "exact tie breaks to the lower note");
    }

    #[test]
    fn every_scale_snaps_to_the_nearest_allowed_note() {
        // Property check over ALL 8 scales x 12 keys x a pitch sweep: a fresh decision (no held note,
        // so no hysteresis) must land on a note of the scale, and no other allowed note may be nearer.
        for scale in 0..8i32 {
            for key in 0..12i32 {
                let mask = SCALE_MASKS[scale as usize];
                let allowed = |note: i32| {
                    let pitch_class = ((note % 12) + 12) % 12;
                    let relative = ((pitch_class - key) % 12 + 12) % 12;
                    (mask >> relative) & 1 == 1
                };
                let mut m = 55.0f64;
                while m <= 67.0 {
                    let mut core = make(48_000.0);
                    core.set_key(key);
                    core.set_scale(scale);
                    let target = core.decide(m);
                    assert!(allowed(target), "scale {scale} key {key} m {m:.2}: target {target} not in scale");
                    let distance = libm::fabs(m - target as f64);
                    for candidate in (target - 12)..=(target + 12) {
                        if allowed(candidate) {
                            assert!(distance <= libm::fabs(m - candidate as f64) + 1.0e-9,
                                "scale {scale} key {key} m {m:.2}: chose {target} (d {distance:.3}) but {candidate} is nearer");
                        }
                    }
                    m += 0.13;
                }
            }
        }
    }

    #[test]
    fn chromatic_snaps_to_the_nearest_semitone() {
        // CHROMATIC: no hysteresis — once the sung centre crosses the 50-cent midpoint the target must
        // be the nearest semitone (the deadband used to hold the old note until 67.5 cents past it).
        let mut chromatic = make(48_000.0);
        chromatic.set_key(0);
        chromatic.set_scale(0);
        for _ in 0..50 {chromatic.decide(60.2);}
        let mut target = 60;
        for _ in 0..200 {target = chromatic.decide(60.6);}
        assert_eq!(target, 61, "chromatic must re-target the nearest semitone past the midpoint");
        // DIATONIC contrast: E(64)/F(65) in C major are also 100 cents apart, but there the deadband
        // still holds the old note at the same 60-cent offset (boundary-hover stability).
        let mut major = make(48_000.0);
        major.set_key(0);
        major.set_scale(1);
        for _ in 0..50 {major.decide(64.2);}
        let mut held = 64;
        for _ in 0..200 {held = major.decide(64.6);}
        assert_eq!(held, 64, "diatonic keeps the hysteresis at the same offset");
    }

    #[test]
    fn flat_tone_is_pulled_up_to_the_scale_note() {
        let sample_rate = 48_000.0;
        let mut core = make(sample_rate);
        core.set_key(9);
        core.set_scale(1);
        core.set_retune(1.0);
        feed_sine(&mut core, 430.0, sample_rate, 48_000);
        let correction = core.current_semitones();
        assert!((0.3..=0.5).contains(&correction), "expected ~+0.4 st, got {correction}");
    }

    #[test]
    fn off_scale_note_snaps_to_the_nearest_degree() {
        let sample_rate = 48_000.0;
        let mut core = make(sample_rate);
        core.set_key(0);
        core.set_scale(1);
        core.set_retune(1.0);
        feed_sine(&mut core, 550.0, sample_rate, 48_000);
        let correction = core.current_semitones();
        assert!((-1.05..=-0.65).contains(&correction), "expected ~-0.86 st, got {correction}");
    }

    #[test]
    fn unvoiced_input_leaves_only_the_shift() {
        let sample_rate = 48_000.0;
        let mut core = make(sample_rate);
        let mut state = 0x12345678u32;
        let noise: Vec<f32> = (0..48_000)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 8) as f32 / 8388608.0 * 0.3 - 0.3
            })
            .collect();
        core.feed(&noise, &noise, 0, noise.len());
        assert_eq!(core.current_semitones(), 0.0, "noise must not produce a correction");
        core.set_shift(3.0);
        assert_eq!(core.current_semitones(), 3.0, "shift passes through on unvoiced input");
    }

    #[test]
    fn amount_zero_is_exactly_transparent() {
        let sample_rate = 48_000.0;
        let mut core = make(sample_rate);
        core.set_amount(0.0);
        feed_sine(&mut core, 430.0, sample_rate, 24_000);
        assert_eq!(core.current_semitones(), 0.0, "amount 0 must yield exactly 0 semitones");
    }

    #[test]
    fn amount_is_square_law_tapered() {
        let sample_rate = 48_000.0;
        let correction_at = |amount: f32| -> f64 {
            let mut core = make(sample_rate);
            core.set_key(0);
            core.set_scale(1);
            core.set_retune(1.0);
            core.set_amount(amount);
            feed_sine(&mut core, 550.0, sample_rate, 48_000);
            core.current_semitones() as f64
        };
        let full = correction_at(1.0);
        let ratio = correction_at(0.5) / full;
        assert!((ratio - 0.25).abs() < 0.03, "amount 0.5 must apply ~1/4 the correction (square law), got {ratio:.3} (full {full:.3})");
    }

    // Run with: cargo test -p dsp diagnose_quality -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diagnose_quality() {
        let sample_rate = 48_000.0f32;
        let seconds = 1.0f32;
        let frames = (sample_rate * seconds) as usize;
        // A harmonic-rich (sawtooth-ish) tone ~32 cents flat of A3 (220 Hz), with 5.5 Hz / ±34 cent vibrato.
        let mut phase = 0.0f64;
        let mut input = vec![0.0f32; frames];
        for index in 0..frames {
            let t = index as f64 / sample_rate as f64;
            let f0 = 216.0 * (1.0 + 0.02 * libm::sin(2.0 * core::f64::consts::PI * 5.5 * t));
            phase += 2.0 * core::f64::consts::PI * f0 / sample_rate as f64;
            let mut sample = 0.0f64;
            for harmonic in 1..=8 {
                sample += libm::sin(harmonic as f64 * phase) / harmonic as f64;
            }
            input[index] = (sample * 0.35) as f32;
        }
        std::eprintln!("--- AUTOTUNE DIAGNOSIS (216Hz sawtooth ±34c vibrato @5.5Hz, A major, amount=1, retune=0.5) ---");
        std::eprintln!("SPEED-WOBBLE = RMS frame-to-frame change of the shift ratio (cents/frame). Higher = more");
        std::eprintln!("audible 'speeding up and down'. It should DROP as smooth rises, and max |correction| stays <=6.\n");
        for smooth in [0.0f32, 0.3, 0.6, 1.0] {
            let mut core: Box<Autotune> = unsafe { Box::new(core::mem::zeroed()) };
            core.prepare(sample_rate);
            core.set_key(9);
            core.set_scale(1);
            core.set_amount(1.0);
            core.set_retune(0.5);
            core.set_smooth(smooth);
            let mut semis_trace: Vec<f64> = Vec::new();
            let mut flips = 0usize;
            let mut prev_target = -1i32;
            let mut offset = 0usize;
            while offset < frames {
                let end = core::cmp::min(offset + 128, frames);
                core.feed(&input, &input, offset, end);
                let (_f0, target, engaged) = core.probe();
                if engaged && offset >= frames / 4 {
                    semis_trace.push(core.current_semitones() as f64);
                    if target != prev_target && prev_target >= 0 {flips += 1;}
                    prev_target = target;
                }
                offset = end;
            }
            let deltas: Vec<f64> = semis_trace.windows(2).map(|pair| 100.0 * (pair[1] - pair[0])).collect();
            let speed_rms = libm::sqrt(deltas.iter().map(|d| d * d).sum::<f64>() / deltas.len().max(1) as f64);
            let max_abs = semis_trace.iter().fold(0.0f64, |acc, v| acc.max(libm::fabs(*v)));
            std::eprintln!("smooth={smooth:.1}: speed-wobble {speed_rms:>5.2} cents/frame, max |correction| {max_abs:.2} st, note-flips {flips}");
        }
    }

    #[test]
    fn hard_retune_flattens_vibrato_soft_keeps_it() {
        // A vibrato tone: at hardness≈1 (retune 1) the correction chases the wobble to pin the pitch onto
        // the grid, so current_semitones swings with it; at hardness 0 (retune 0) the correction is steady
        // and the vibrato passes through untouched. Measure the swing (std of the commanded semitones).
        let sample_rate = 48_000.0f32;
        let frames = 48_000usize;
        let mut phase = 0.0f64;
        let mut input = vec![0.0f32; frames];
        for index in 0..frames {
            let t = index as f64 / sample_rate as f64;
            let f0 = 220.0 * libm::pow(2.0, 0.025 * libm::sin(2.0 * core::f64::consts::PI * 5.5 * t)); // ±30 cents
            phase += 2.0 * core::f64::consts::PI * f0 / sample_rate as f64;
            let sample: f64 = (1..=6).map(|harmonic| libm::sin(harmonic as f64 * phase) / harmonic as f64).sum();
            input[index] = (sample * 0.3) as f32;
        }
        let swing = |retune: f32| -> f64 {
            let mut core = make(sample_rate);
            core.set_key(0);
            core.set_scale(0);
            core.set_amount(1.0);
            core.set_retune(retune);
            core.set_smooth(0.0);
            let mut trace: Vec<f64> = Vec::new();
            let mut offset = 0usize;
            while offset < frames {
                let end = core::cmp::min(offset + 128, frames);
                core.feed(&input, &input, offset, end);
                if offset >= frames / 2 {trace.push(core.current_semitones() as f64);}
                offset = end;
            }
            let mean = trace.iter().sum::<f64>() / trace.len() as f64;
            libm::sqrt(trace.iter().map(|value| (value - mean) * (value - mean)).sum::<f64>() / trace.len() as f64)
        };
        let soft = swing(0.0);
        let hard = swing(1.0);
        assert!(hard > soft * 3.0 + 0.02, "hard retune must chase the vibrato far more than soft (hard {hard:.3}, soft {soft:.3})");
    }

    #[test]
    fn flatten_survives_the_smooth_filter() {
        // The vibrato-flatten path must bypass the smooth one-pole: at retune 1.0 the anti-vibrato swing
        // with smooth 0.6 must stay close to the swing with smooth 0.0. (Before the split, smooth 0.6
        // low-passed the ~5.5Hz modulation to ~28% — vibrato reduction silently stopped working.)
        let sample_rate = 48_000.0f32;
        let frames = 48_000usize;
        let mut phase = 0.0f64;
        let mut input = vec![0.0f32; frames];
        for index in 0..frames {
            let t = index as f64 / sample_rate as f64;
            let f0 = 220.0 * libm::pow(2.0, 0.025 * libm::sin(2.0 * core::f64::consts::PI * 5.5 * t));
            phase += 2.0 * core::f64::consts::PI * f0 / sample_rate as f64;
            let sample: f64 = (1..=6).map(|harmonic| libm::sin(harmonic as f64 * phase) / harmonic as f64).sum();
            input[index] = (sample * 0.3) as f32;
        }
        let swing = |smooth: f32| -> f64 {
            let mut core = make(sample_rate);
            core.set_key(0);
            core.set_scale(0);
            core.set_amount(1.0);
            core.set_retune(1.0);
            core.set_smooth(smooth);
            let mut trace: Vec<f64> = Vec::new();
            let mut offset = 0usize;
            while offset < frames {
                let end = core::cmp::min(offset + 128, frames);
                core.feed(&input, &input, offset, end);
                if offset >= frames / 2 {trace.push(core.current_semitones() as f64);}
                offset = end;
            }
            let mean = trace.iter().sum::<f64>() / trace.len() as f64;
            libm::sqrt(trace.iter().map(|value| (value - mean) * (value - mean)).sum::<f64>() / trace.len() as f64)
        };
        let open = swing(0.0);
        let damped = swing(0.6);
        assert!(damped > open * 0.7, "smooth must not strangle the flatten (open {open:.3}, damped {damped:.3})");
    }

    #[test]
    fn retune_controls_the_glide_speed() {
        let sample_rate = 48_000.0;
        let frames = 12_000;
        let mut fast = make(sample_rate);
        fast.set_key(9);
        fast.set_retune(1.0);
        feed_sine(&mut fast, 430.0, sample_rate, frames);
        let mut slow = make(sample_rate);
        slow.set_key(9);
        slow.set_retune(0.0);
        feed_sine(&mut slow, 430.0, sample_rate, frames);
        assert!(fast.current_semitones() > 0.3, "fast retune should have converged, got {}", fast.current_semitones());
        assert!(slow.current_semitones() < 0.3, "slow retune should lag, got {}", slow.current_semitones());
        assert!(slow.current_semitones() > 0.0, "slow retune still moves toward the target");
    }
}
