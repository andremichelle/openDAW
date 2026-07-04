//! A stereo peak + RMS meter (the engine port of TS `PeakBroadcaster`'s DSP + lib-dsp `RMS`): a 250 ms
//! peak decay and a 100 ms RMS window per channel, written each quantum into a SHARED 4-float slot
//! (`[peakL, peakR, rmsL, rmsR]`) the JS `LiveStreamBroadcaster` reads as a live view over wasm memory.
//! The slot lives behind an `Rc` (a stable talc heap address for the processor's life); the ring buffers
//! are allocated at construction (reconcile), never on the render path.

use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;

const PEAK_DECAY_SECONDS: f32 = 0.250; // TS PeakBroadcaster.PEAK_DECAY
const RMS_WINDOW_SECONDS: f32 = 0.100; // TS PeakBroadcaster.RMS_WINDOW

/// The sliding-window RMS (lib-dsp `RMS`): a ring of squares with a running sum.
struct Rms {
    values: Vec<f32>,
    inv: f64,
    index: usize,
    sum: f64
}

impl Rms {
    fn new(window: usize) -> Self {
        let window = window.max(1);
        Self {values: vec![0.0; window], inv: 1.0 / window as f64, index: 0, sum: 0.0}
    }

    fn process_block(&mut self, samples: &[f32]) -> f32 {
        for &sample in samples {
            let squared = (sample * sample) as f64;
            self.sum -= self.values[self.index] as f64;
            self.sum += squared;
            self.values[self.index] = squared as f32;
            self.index += 1;
            if self.index == self.values.len() {
                self.index = 0;
            }
        }
        if self.sum <= 0.0 { 0.0 } else { math::sqrt(self.sum * self.inv) as f32 }
    }

    fn clear(&mut self) {
        self.values.fill(0.0);
        self.sum = 0.0;
        self.index = 0;
    }
}

/// The shared slot a meter writes and the broadcast table points at.
pub type MeterSlot = Rc<RefCell<[f32; 4]>>;

pub struct Meter {
    slot: MeterSlot,
    decay_base: f64, // PEAK_DECAY = exp(-1 / (sr * 0.25)); applied as decay_base^samples per block
    peak_left: f32,
    peak_right: f32,
    rms_left: Rms,
    rms_right: Rms
}

impl Meter {
    pub fn new(sample_rate: f32) -> Self {
        let window = (sample_rate * RMS_WINDOW_SECONDS) as usize;
        Self {
            slot: Rc::new(RefCell::new([0.0; 4])),
            decay_base: math::exp(-1.0 / (sample_rate as f64 * PEAK_DECAY_SECONDS as f64)),
            peak_left: 0.0,
            peak_right: 0.0,
            rms_left: Rms::new(window),
            rms_right: Rms::new(window)
        }
    }

    /// The slot handle (keep an `Rc` clone wherever the values must outlive this meter's owner) and the raw
    /// pointer the broadcast table hands to JS. Stable for the owning processor's life (talc never moves).
    pub fn slot(&self) -> MeterSlot {
        self.slot.clone()
    }

    pub fn values_ptr(&self) -> u32 {
        self.slot.as_ptr() as u32
    }

    /// Meter one rendered quantum: block peak vs the decayed held peak, plus the sliding RMS.
    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        let mut max_left = 0.0f32;
        let mut max_right = 0.0f32;
        for index in 0..left.len().min(right.len()) {
            let abs_left = left[index].abs();
            let abs_right = right[index].abs();
            if abs_left > max_left {
                max_left = abs_left;
            }
            if abs_right > max_right {
                max_right = abs_right;
            }
        }
        let decay = math::pow(self.decay_base, left.len() as f64) as f32;
        self.peak_left = max_left.max(self.peak_left * decay);
        self.peak_right = max_right.max(self.peak_right * decay);
        let rms_left = self.rms_left.process_block(left);
        let rms_right = self.rms_right.process_block(right);
        let mut slot = self.slot.borrow_mut();
        slot[0] = self.peak_left;
        slot[1] = self.peak_right;
        slot[2] = rms_left;
        slot[3] = rms_right;
    }

    /// Transport stop / disable: silence the meter (TS `PeakBroadcaster.clear`).
    pub fn clear(&mut self) {
        self.peak_left = 0.0;
        self.peak_right = 0.0;
        self.rms_left.clear();
        self.rms_right.clear();
        *self.slot.borrow_mut() = [0.0; 4];
    }
}

#[cfg(test)]
mod tests {
    use super::Meter;

    #[test]
    fn peaks_hold_with_decay_and_rms_follows_energy() {
        let mut meter = Meter::new(48_000.0);
        let loud = [0.5f32; 128];
        meter.process(&loud, &loud);
        {
            let slot = meter.slot();
            let values = slot.borrow();
            assert_eq!(values[0], 0.5, "peak = the block max");
            assert!(values[2] > 0.0 && values[2] <= 0.5, "rms grows toward the level");
        }
        let silence = [0.0f32; 128];
        meter.process(&silence, &silence);
        {
            let slot = meter.slot();
            let values = slot.borrow();
            assert!(values[0] < 0.5 && values[0] > 0.45, "the held peak decays slowly (250 ms)");
        }
        meter.clear();
        assert_eq!(*meter.slot().borrow(), [0.0; 4]);
    }
}
