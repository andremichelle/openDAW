//! A port of signalsmith-linear's `DynamicSTFT<float, false, STFT_SPECTRUM_MODIFIED>` (the exact
//! configuration the Signalsmith Stretch algorithm uses): a self-normalising STFT with a Kaiser window
//! forced to perfect reconstruction, circular input/output buffers, and per-sample window-product
//! normalisation on the output.
//!
//! MODIFIED spectrum: every bin sits half a bin up (`bin_to_freq(b) = (b + 0.5) / fft_samples`), so there is
//! no DC/Nyquist special casing — all `fft_samples/2` bands are ordinary complex bins. Upstream folds that
//! half-bin shift into a modified real FFT; here it is explicit: the rotated windowed block (sign-flipped on
//! the wrapped half, which continues the shift's phase across the wrap) is modulated by `e^(-i*pi*n/N)`,
//! transformed with a plain complex FFT, and the top half discarded (conjugate symmetry). Synthesis mirrors
//! that: rebuild the full spectrum by symmetry, inverse FFT, demodulate, window, overlap-add.
//!
//! Deviations from upstream, both deliberate: fft sizes are powers of two (not 2^a*3^b), and the
//! split-computation machinery is dropped (openDAW's engine renders per quantum on one thread; the stretch
//! runs whole blocks at block boundaries).

use alloc::vec::Vec;
use super::fft::{Complex, ComplexFft};

const ALMOST_ZERO: f32 = 1e-30;

fn bessel0(x: f64) -> f64 {
    let significance_limit = 1e-4;
    let mut result = 0.0;
    let mut term = 1.0;
    let mut m = 0.0;
    while term > significance_limit {
        result += term;
        m += 1.0;
        term *= (x * x) / (4.0 * m * m);
    }
    result
}

fn kaiser_bandwidth_to_beta(bandwidth: f64) -> f64 {
    // upstream's heuristicOptimal=true path (numerical-search heuristic), then alpha*pi
    let heuristic = bandwidth + 8.0 / ((bandwidth + 3.0) * (bandwidth + 3.0)) + 0.25 * (3.0 - bandwidth).max(0.0);
    let clamped = heuristic.max(2.0);
    math::sqrt(clamped * clamped * 0.25 - 1.0) * core::f64::consts::PI
}

fn fill_kaiser(window: &mut [f32], beta: f64, is_for_synthesis: bool) {
    let size = window.len();
    let inv_b0 = 1.0 / bessel0(beta);
    let inv_size = 1.0 / size as f64;
    let offset = if size & 1 == 1 {1} else if is_for_synthesis {0} else {2};
    for (index, value) in window.iter_mut().enumerate() {
        let r = (2 * index + offset) as f64 * inv_size - 1.0;
        let arg = math::sqrt((1.0 - r * r).max(0.0));
        *value = (bessel0(beta * arg) * inv_b0) as f32;
    }
}

fn force_perfect_reconstruction(window: &mut [f32], interval: usize) {
    for phase in 0..interval {
        let mut sum2 = 0.0f64;
        let mut index = phase;
        while index < window.len() {
            sum2 += (window[index] as f64) * (window[index] as f64);
            index += interval;
        }
        let factor = 1.0 / math::sqrt(sum2);
        let mut index = phase;
        while index < window.len() {
            window[index] = (window[index] as f64 * factor) as f32;
            index += interval;
        }
    }
}

pub(crate) struct DynamicStft {
    channels: usize,
    block_samples: usize,
    fft_samples: usize,
    bands: usize,
    input_length: usize,
    default_interval: usize,
    analysis_offset: usize,
    synthesis_offset: usize,
    window: Vec<f32>, // analysis == synthesis (symmetric window, no asymmetry support needed)
    fft: ComplexFft,
    // e^(-i*pi*n/N) per time index, the explicit half-bin modulation (conjugated for synthesis)
    modulation: Vec<Complex>,
    input_pos: usize,
    input_buffer: Vec<f32>, // channels * input_length
    output_pos: usize,
    output_buffer: Vec<f32>, // channels * block_samples
    window_products: Vec<f32>,
    spectrum: Vec<Complex>, // channels * bands
    time_buffer: Vec<Complex>
}

impl DynamicStft {
    pub(crate) fn new() -> Self {
        Self {
            channels: 0, block_samples: 0, fft_samples: 0, bands: 0, input_length: 0, default_interval: 0,
            analysis_offset: 0, synthesis_offset: 0, window: Vec::new(), fft: ComplexFft::new(1),
            modulation: Vec::new(), input_pos: 0, input_buffer: Vec::new(), output_pos: 0,
            output_buffer: Vec::new(), window_products: Vec::new(), spectrum: Vec::new(), time_buffer: Vec::new()
        }
    }

    pub(crate) fn configure(&mut self, channels: usize, block_samples: usize, extra_input_history: usize, interval_samples: usize) {
        self.channels = channels;
        self.block_samples = block_samples;
        self.fft_samples = ((block_samples + 1) / 2).next_power_of_two() * 2;
        self.bands = self.fft_samples / 2;
        self.input_length = block_samples + extra_input_history;
        self.fft = ComplexFft::new(self.fft_samples);
        self.input_buffer.clear();
        self.input_buffer.resize(self.input_length * channels, 0.0);
        self.output_buffer.clear();
        self.output_buffer.resize(block_samples * channels, 0.0);
        self.window_products.clear();
        self.window_products.resize(block_samples, 0.0);
        self.spectrum.clear();
        self.spectrum.resize(self.bands * channels, Complex::ZERO);
        self.time_buffer.clear();
        self.time_buffer.resize(self.fft_samples, Complex::ZERO);
        self.modulation.clear();
        for n in 0..self.fft_samples {
            let angle = -core::f64::consts::PI * n as f64 / self.fft_samples as f64;
            self.modulation.push(Complex::new(math::cos(angle as f32), math::sin(angle as f32)));
        }
        self.window.clear();
        self.window.resize(block_samples, 0.0);
        self.set_interval(interval_samples);
        self.reset(1.0);
    }

    pub(crate) fn set_interval(&mut self, interval: usize) {
        self.default_interval = interval;
        let beta = kaiser_bandwidth_to_beta(self.block_samples as f64 / interval as f64);
        fill_kaiser(&mut self.window, beta, true);
        force_perfect_reconstruction(&mut self.window, interval);
        let mut peak = self.block_samples / 2;
        for index in 0..self.block_samples {
            if self.window[index] > self.window[peak] {
                peak = index;
            }
        }
        self.analysis_offset = peak;
        self.synthesis_offset = peak;
    }

    pub(crate) fn block_samples(&self) -> usize {
        self.block_samples
    }

    pub(crate) fn fft_samples(&self) -> usize {
        self.fft_samples
    }

    pub(crate) fn bands(&self) -> usize {
        self.bands
    }

    pub(crate) fn default_interval(&self) -> usize {
        self.default_interval
    }

    pub(crate) fn analysis_latency(&self) -> usize {
        self.block_samples - self.analysis_offset
    }

    pub(crate) fn synthesis_latency(&self) -> usize {
        self.synthesis_offset
    }

    pub(crate) fn bin_to_freq(&self, bin: f32) -> f32 {
        (bin + 0.5) / self.fft_samples as f32
    }

    pub(crate) fn freq_to_bin(&self, freq: f32) -> f32 {
        freq * self.fft_samples as f32 - 0.5
    }

    pub(crate) fn spectrum(&self, channel: usize) -> &[Complex] {
        &self.spectrum[channel * self.bands..(channel + 1) * self.bands]
    }

    pub(crate) fn spectrum_mut(&mut self, channel: usize) -> &mut [Complex] {
        &mut self.spectrum[channel * self.bands..(channel + 1) * self.bands]
    }

    pub(crate) fn reset(&mut self, product_weight: f32) {
        self.input_pos = self.block_samples % self.input_length.max(1);
        self.output_pos = 0;
        for value in self.input_buffer.iter_mut() {*value = 0.0}
        for value in self.output_buffer.iter_mut() {*value = 0.0}
        for value in self.spectrum.iter_mut() {*value = Complex::ZERO}
        for value in self.window_products.iter_mut() {*value = 0.0}
        self.add_window_product();
        // pretend previous blocks already overlapped in, so the very first output isn't over-normalised
        let interval = self.default_interval;
        for index in (0..self.block_samples.saturating_sub(interval)).rev() {
            self.window_products[index] += self.window_products[index + interval];
        }
        for value in self.window_products.iter_mut() {*value = *value * product_weight + ALMOST_ZERO}
        self.move_output(interval);
    }

    pub(crate) fn write_input(&mut self, channel: usize, length: usize, samples: &[f32]) {
        let buffer = &mut self.input_buffer[channel * self.input_length..(channel + 1) * self.input_length];
        let offset_pos = self.input_pos % self.input_length;
        for (index, &sample) in samples.iter().enumerate().take(length) {
            buffer[(offset_pos + index) % self.input_length] = sample;
        }
    }

    pub(crate) fn move_input(&mut self, samples: usize, clear_input: bool) {
        if clear_input {
            for channel in 0..self.channels {
                let buffer = &mut self.input_buffer[channel * self.input_length..(channel + 1) * self.input_length];
                for index in 0..samples {
                    buffer[(self.input_pos + index) % self.input_length] = 0.0;
                }
            }
        }
        self.input_pos = (self.input_pos + samples) % self.input_length;
    }

    /// Analyse the block ENDING at the input position (optionally `samples_in_past` earlier) into `spectrum`.
    pub(crate) fn analyse(&mut self, samples_in_past: usize) {
        let block = self.block_samples;
        let fft_size = self.fft_samples;
        let offset = self.analysis_offset;
        for channel in 0..self.channels {
            let offset_pos = (self.input_length * 2 + self.input_pos - block - samples_in_past) % self.input_length;
            for value in self.time_buffer.iter_mut() {*value = Complex::ZERO}
            for index in 0..block {
                let sample = self.input_buffer[channel * self.input_length + (offset_pos + index) % self.input_length];
                // wrapped half gets the sign flip that continues the half-bin shift's phase across the wrap
                let (time_index, sign) = if index < offset {
                    (index + fft_size - offset, -1.0f32)
                } else {
                    (index - offset, 1.0f32)
                };
                let windowed = sample * self.window[index] * sign;
                self.time_buffer[time_index] = self.modulation[time_index].scale(windowed);
            }
            self.fft.forward(&mut self.time_buffer);
            let bands = self.bands;
            for band in 0..bands {
                self.spectrum[channel * bands + band] = self.time_buffer[band];
            }
        }
    }

    /// Overlap-add the current `spectrum` into the output ring (adding the window product first).
    pub(crate) fn synthesise(&mut self) {
        self.add_window_product();
        let block = self.block_samples;
        let fft_size = self.fft_samples;
        let offset = self.synthesis_offset;
        for channel in 0..self.channels {
            let bands = self.bands;
            for band in 0..bands {
                let value = self.spectrum[channel * bands + band];
                self.time_buffer[band] = value;
                self.time_buffer[fft_size - 1 - band] = value.conj();
            }
            self.fft.inverse(&mut self.time_buffer);
            for index in 0..block {
                let (time_index, sign) = if index < offset {
                    (index + fft_size - offset, -1.0f32)
                } else {
                    (index - offset, 1.0f32)
                };
                // demodulate: the inverse of y[n] = x[n] * e^(-i*pi*n/N) for real x is re(y[n] * e^(+i*pi*n/N))
                let sample = self.time_buffer[time_index].mul_conj(self.modulation[time_index]).re * sign;
                let buffer_index = channel * block + (self.output_pos + index) % block;
                self.output_buffer[buffer_index] += sample * self.window[index];
            }
        }
    }

    fn add_window_product(&mut self) {
        // analysis window == synthesis window and offsets match, so the shift is zero
        for index in 0..self.block_samples {
            let wa = self.window[index];
            let ws = self.window[index];
            let buffer_index = (self.output_pos + index) % self.block_samples;
            self.window_products[buffer_index] += wa * ws * self.fft_samples as f32;
        }
    }

    /// Taper the normalisation for a final drain, so the tail decays with the window instead of exploding.
    pub(crate) fn finish_output(&mut self, strength: f32) {
        let mut max_window_product = 0.0f32;
        for index in 0..self.block_samples {
            let buffer_index = (self.output_pos + index) % self.block_samples;
            let product = self.window_products[buffer_index];
            max_window_product = max_window_product.max(product);
            self.window_products[buffer_index] = product + (max_window_product - product) * strength;
        }
    }

    pub(crate) fn read_output(&self, channel: usize, offset: usize, length: usize, out: &mut [f32]) {
        let block = self.block_samples;
        let buffer = &self.output_buffer[channel * block..(channel + 1) * block];
        for index in 0..length {
            let buffer_index = (self.output_pos + offset + index) % block;
            out[index] = buffer[buffer_index] / self.window_products[buffer_index];
        }
    }

    /// Add pre-normalised samples into the output ring (they get re-multiplied by the window product, so a
    /// later `read_output` returns them unchanged) — used by the stretch's output-seek pre-roll.
    pub(crate) fn add_output(&mut self, channel: usize, length: usize, samples: &[f32]) {
        let block = self.block_samples;
        let length = length.min(block);
        for index in 0..length {
            let buffer_index = (self.output_pos + index) % block;
            self.output_buffer[channel * block + buffer_index] += samples[index] * self.window_products[buffer_index];
        }
    }

    pub(crate) fn move_output(&mut self, samples: usize) {
        for _ in 0..samples.min(self.block_samples) {
            for channel in 0..self.channels {
                self.output_buffer[channel * self.block_samples + self.output_pos] = 0.0;
            }
            self.window_products[self.output_pos] = ALMOST_ZERO;
            self.output_pos += 1;
            if self.output_pos >= self.block_samples {
                self.output_pos = 0;
            }
        }
        if samples > self.block_samples {
            self.output_pos = (self.output_pos + samples - self.block_samples) % self.block_samples;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn window_is_perfect_reconstruction() {
        let mut stft = DynamicStft::new();
        stft.configure(1, 512, 129, 128);
        for phase in 0..128 {
            let mut sum2 = 0.0f32;
            let mut index = phase;
            while index < 512 {
                sum2 += stft.window[index] * stft.window[index];
                index += 128;
            }
            assert!((sum2 - 1.0).abs() < 1e-4, "phase {phase}: sum {sum2}");
        }
    }

    #[test]
    fn analyse_synthesise_round_trip_reconstructs_a_sine() {
        // Push a sine through analyse+synthesise at the default interval; after the window products settle,
        // the output must equal the input delayed by the STFT latency.
        let block = 512usize;
        let interval = 128usize;
        let mut stft = DynamicStft::new();
        stft.configure(1, block, interval + 1, interval);
        let total = block * 8;
        let input: vec::Vec<f32> = (0..total)
            .map(|index| math::sin(index as f32 * 0.05) * 0.5)
            .collect();
        let mut output = vec![0.0f32; total];
        let mut write_position = 0usize;
        let mut read_position = 0usize;
        while write_position < total {
            stft.write_input(0, interval, &input[write_position..write_position + interval]);
            stft.move_input(interval, false);
            write_position += interval;
            stft.analyse(0);
            stft.synthesise();
            if read_position + interval <= total {
                let (chunk, rest) = output.split_at_mut(read_position + interval);
                let _ = rest;
                stft.read_output(0, 0, interval, &mut chunk[read_position..]);
            }
            read_position += interval;
            stft.move_output(interval);
        }
        let latency = stft.analysis_latency() + stft.synthesis_latency();
        let mut max_error = 0.0f32;
        for index in block * 2..total - latency {
            let error = (output[index + latency - interval] - input[index]).abs();
            max_error = max_error.max(error);
        }
        assert!(max_error < 0.02, "round trip error {max_error}");
    }
}
