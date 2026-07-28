//! A stereo peak + RMS meter for DEVICE-side telemetry (the TS `PeakBroadcaster` DSP + lib-dsp `RMS`):
//! a 250 ms peak decay and a 300 ms sliding RMS window per channel, written as `[peakL, peakR, rmsL, rmsR]`
//! into a caller-provided slice (a device's broadcast slot). ALLOCATION-FREE (device crates have no
//! allocator), built IN PLACE via `init`. The ring stores one mean-square per 128-frame bucket (not per
//! sample), so the window slides in bucket steps: rate-correct at any sample rate, 2 KB per channel.
//! The engine-side twin (`engine_env::meter`) owns a shared slot and may allocate; this one is for
//! plugin crates.

const PEAK_DECAY_SECONDS: f64 = 0.250; // TS PeakBroadcaster.PEAK_DECAY
const RMS_WINDOW_SECONDS: f32 = 0.300; // TS PeakBroadcaster.RMS_WINDOW
const BUCKET_FRAMES: usize = 128; // one render quantum; sub-quantum blocks accumulate until full
const RING_CAPACITY: usize = 512; // 300 ms in buckets up to ~218 kHz

struct Rms {
    values: [f32; RING_CAPACITY], // per-bucket mean-squares
    window: usize,                // window length in buckets
    index: usize,
    sum: f64,                     // running sum of the ring window's mean-squares
    bucket_sum: f64,              // squares accumulated in the open bucket
    bucket_count: usize
}

impl Rms {
    fn init(&mut self, window_buckets: usize) {
        self.window = window_buckets.clamp(1, RING_CAPACITY);
        self.values[..self.window].fill(0.0);
        self.index = 0;
        self.sum = 0.0;
        self.bucket_sum = 0.0;
        self.bucket_count = 0;
    }

    fn process_block(&mut self, samples: &[f32]) -> f32 {
        for &sample in samples {
            self.bucket_sum += (sample * sample) as f64;
            self.bucket_count += 1;
            if self.bucket_count == BUCKET_FRAMES {
                let mean = (self.bucket_sum / BUCKET_FRAMES as f64) as f32;
                self.sum -= self.values[self.index] as f64;
                self.sum += mean as f64;
                self.values[self.index] = mean;
                self.index += 1;
                if self.index == self.window {
                    self.index = 0;
                }
                self.bucket_sum = 0.0;
                self.bucket_count = 0;
            }
        }
        let total = self.sum.max(0.0) * BUCKET_FRAMES as f64 + self.bucket_sum;
        if total <= 0.0 {
            0.0
        } else {
            let count = (self.window * BUCKET_FRAMES + self.bucket_count) as f64;
            math::sqrt(total / count) as f32
        }
    }

    fn clear(&mut self) {
        self.values[..self.window].fill(0.0);
        self.sum = 0.0;
        self.index = 0;
        self.bucket_sum = 0.0;
        self.bucket_count = 0;
    }
}

pub struct StereoMeter {
    decay_base: f64,
    peak_left: f32,
    peak_right: f32,
    rms_left: Rms,
    rms_right: Rms
}

impl StereoMeter {
    /// Build IN PLACE (the state block arrives zeroed).
    pub fn init(&mut self, sample_rate: f32) {
        let window = (((sample_rate * RMS_WINDOW_SECONDS) as usize) + BUCKET_FRAMES / 2) / BUCKET_FRAMES;
        self.decay_base = math::exp(-1.0 / (sample_rate as f64 * PEAK_DECAY_SECONDS));
        self.peak_left = 0.0;
        self.peak_right = 0.0;
        self.rms_left.init(window);
        self.rms_right.init(window);
    }

    /// Meter one block into `out` (`[peakL, peakR, rmsL, rmsR]`): block peak vs the decayed held peak,
    /// plus the sliding RMS.
    pub fn process(&mut self, left: &[f32], right: &[f32], out: &mut [f32]) {
        let mut max_left = 0.0f32;
        let mut max_right = 0.0f32;
        for index in 0..left.len().min(right.len()) {
            max_left = max_left.max(left[index].abs());
            max_right = max_right.max(right[index].abs());
        }
        let decay = math::pow(self.decay_base, left.len() as f64) as f32;
        self.peak_left = max_left.max(self.peak_left * decay);
        self.peak_right = max_right.max(self.peak_right * decay);
        out[0] = self.peak_left;
        out[1] = self.peak_right;
        out[2] = self.rms_left.process_block(left);
        out[3] = self.rms_right.process_block(right);
    }

    pub fn clear(&mut self, out: &mut [f32]) {
        self.peak_left = 0.0;
        self.peak_right = 0.0;
        self.rms_left.clear();
        self.rms_right.clear();
        out[..4].fill(0.0);
    }
}
