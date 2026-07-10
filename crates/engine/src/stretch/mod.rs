//! The COMPLEX-HQ stretch: a faithful `no_std` port of Signalsmith Stretch v1.3.2 (MIT, © Signalsmith
//! Audio), the STFT band phase-prediction time-stretcher behind the studio's offline "Render HQ Stretch".
//! Where the granular `time_stretch` keeps transients sharp by re-triggering segments, this keeps polyphonic
//! and tonal material clean at any tempo ratio: each spectral band's output phase is re-predicted every
//! interval by blending up to four phase relationships measured from the input (one interval back, plus
//! short and long vertical neighbours up/down), energy-weighted via complex multiplication, with the
//! loudest channel leading and the others phase-locked to it. Pitch-shifting maps peaks through a
//! smoothstep-interpolated output map (with a tonality limit), and formants can be preserved or shifted via
//! a spectral-envelope metric.
//!
//! Port deviations from upstream, all deliberate:
//!  - no `splitComputation` (openDAW renders per quantum on one thread; blocks compute at boundaries),
//!    which also removes the stashed input/output state entirely;
//!  - power-of-two FFT sizes (see `stft.rs`);
//!  - `Mulberry32` replaces `std::default_random_engine` (only used past 2x stretch, where upstream
//!    randomises per-bin time offsets to avoid metallic resonance);
//!  - no custom frequency-map callback (openDAW only needs multiplier + tonality limit).

// consumed by the COMPLEX play-mode integration; the API surface lands before its engine wiring
#![allow(dead_code)]

mod fft;
mod stft;

use alloc::vec::Vec;
use math::random::Mulberry32;
use fft::Complex;
use stft::DynamicStft;

const NOISE_FLOOR: f32 = 1e-15;
const MAX_CLEAN_STRETCH: f32 = 2.0;

fn floor_i32(value: f32) -> i32 {
    math::floor(value as f64) as i32
}

fn sqrt_f32(value: f32) -> f32 {
    math::sqrt(value as f64) as f32
}

#[derive(Clone, Copy, Default)]
struct Band {
    input: Complex,
    prev_input: Complex,
    output: Complex,
    input_energy: f32
}

#[derive(Clone, Copy)]
struct Peak {
    input: f32,
    output: f32
}

#[derive(Clone, Copy, Default)]
struct MapPoint {
    input_bin: f32,
    freq_grad: f32
}

#[derive(Clone, Copy, Default)]
struct Prediction {
    energy: f32,
    input: Complex
}

impl Prediction {
    fn make_output(&self, phase: Complex) -> Complex {
        let mut phase = phase;
        let mut phase_norm = phase.norm();
        if phase_norm <= NOISE_FLOOR {
            phase = self.input;
            phase_norm = self.input.norm() + NOISE_FLOOR;
        }
        phase.scale(sqrt_f32(self.energy / phase_norm))
    }
}

pub(crate) struct ComplexStretch {
    stft: DynamicStft,
    channels: usize,
    bands: usize,
    channel_bands: Vec<Band>,
    peaks: Vec<Peak>,
    energy: Vec<f32>,
    smoothed_energy: Vec<f32>,
    output_map: Vec<MapPoint>,
    predictions: Vec<Prediction>,
    formant_metric: Vec<f32>,
    freq_multiplier: f32,
    freq_tonality_limit: f32,
    formant_compensation: bool,
    formant_multiplier: f32,
    inv_formant_multiplier: f32,
    formant_base_freq: f32,
    prev_input_offset: i64,
    prev_copied_input: i64,
    did_seek: bool,
    seek_time_factor: f32,
    silence_counter: usize,
    silence_first: bool,
    samples_since_last: usize,
    freq_estimate_weighted: f32,
    freq_estimate_weight: f32,
    freq_estimate: f32,
    smooth_energy_state: f32,
    rng: Mulberry32,
    tmp_buffer: Vec<f32>,
    preroll_buffer: Vec<f32>
}

impl ComplexStretch {
    pub(crate) fn new() -> Self {
        Self {
            stft: DynamicStft::new(), channels: 0, bands: 0, channel_bands: Vec::new(), peaks: Vec::new(),
            energy: Vec::new(), smoothed_energy: Vec::new(), output_map: Vec::new(), predictions: Vec::new(),
            formant_metric: Vec::new(), freq_multiplier: 1.0, freq_tonality_limit: 0.5,
            formant_compensation: false, formant_multiplier: 1.0, inv_formant_multiplier: 1.0,
            formant_base_freq: 0.0, prev_input_offset: -1, prev_copied_input: 0, did_seek: false,
            seek_time_factor: 1.0, silence_counter: 0, silence_first: true, samples_since_last: usize::MAX,
            freq_estimate_weighted: 0.0, freq_estimate_weight: 0.0, freq_estimate: 0.0,
            smooth_energy_state: 0.0, rng: Mulberry32::new(0x9E37_79B9), tmp_buffer: Vec::new(),
            preroll_buffer: Vec::new()
        }
    }

    /// Upstream's default preset rounded to a power-of-two block (~85ms @48k with 4x overlap), which makes
    /// the fft size exactly the block size.
    pub(crate) fn preset_default(&mut self, channels: usize, sample_rate: f32) {
        let block = ((sample_rate * 0.1) as usize).next_power_of_two();
        self.configure(channels, block, block / 4);
    }

    pub(crate) fn configure(&mut self, channels: usize, block_samples: usize, interval_samples: usize) {
        self.channels = channels;
        self.stft.configure(channels, block_samples, interval_samples + 1, interval_samples);
        self.bands = self.stft.bands();
        self.channel_bands.clear();
        self.channel_bands.resize(self.bands * channels, Band::default());
        self.peaks = Vec::with_capacity(self.bands / 2);
        self.energy.clear();
        self.energy.resize(self.bands, 0.0);
        self.smoothed_energy.clear();
        self.smoothed_energy.resize(self.bands, 0.0);
        self.output_map.clear();
        self.output_map.resize(self.bands, MapPoint::default());
        self.predictions.clear();
        self.predictions.resize(self.bands * channels, Prediction::default());
        self.formant_metric.clear();
        self.formant_metric.resize(self.bands + 2, 0.0);
        self.tmp_buffer = Vec::with_capacity(block_samples + interval_samples);
        self.preroll_buffer = Vec::with_capacity(self.output_latency() * channels);
        self.reset();
    }

    pub(crate) fn input_latency(&self) -> usize {
        self.stft.analysis_latency()
    }

    pub(crate) fn output_latency(&self) -> usize {
        self.stft.synthesis_latency()
    }

    pub(crate) fn reset(&mut self) {
        self.stft.reset(0.1);
        self.prev_input_offset = -1;
        self.prev_copied_input = 0;
        for band in self.channel_bands.iter_mut() {*band = Band::default()}
        self.silence_counter = 0;
        self.silence_first = true;
        self.did_seek = false;
        self.samples_since_last = usize::MAX;
        self.freq_estimate_weighted = 0.0;
        self.freq_estimate_weight = 0.0;
    }

    /// Frequency multiplier for pitch-shifting, with an optional tonality limit (cycles/sample).
    pub(crate) fn set_transpose_factor(&mut self, multiplier: f32, tonality_limit: f32) {
        self.freq_multiplier = multiplier;
        self.freq_tonality_limit = if tonality_limit > 0.0 {
            tonality_limit / sqrt_f32(multiplier)
        } else {
            1.0
        };
    }

    pub(crate) fn set_transpose_semitones(&mut self, semitones: f32, tonality_limit: f32) {
        self.set_transpose_factor(math::pow(2.0, semitones as f64 / 12.0) as f32, tonality_limit);
    }

    pub(crate) fn set_formant_factor(&mut self, multiplier: f32, compensate_pitch: bool) {
        self.formant_multiplier = multiplier;
        self.inv_formant_multiplier = 1.0 / multiplier;
        self.formant_compensation = compensate_pitch;
    }

    pub(crate) fn set_formant_semitones(&mut self, semitones: f32, compensate_pitch: bool) {
        self.set_formant_factor(math::pow(2.0, semitones as f64 / 12.0) as f32, compensate_pitch);
    }

    /// Rough fundamental (cycles/sample) used for formant analysis; 0 attempts pitch detection.
    pub(crate) fn set_formant_base(&mut self, base_freq: f32) {
        self.formant_base_freq = base_freq;
    }

    pub(crate) fn seek_length(&self) -> usize {
        self.stft.block_samples() + self.stft.default_interval()
    }

    pub(crate) fn output_seek_length(&self, playback_rate: f32) -> usize {
        self.input_latency() + (playback_rate * self.output_latency() as f32) as usize
    }

    /// Pre-roll input (ideally `seek_length()` frames) so the input location can jump without breaking the
    /// output. No spectral work happens here, just buffer writes.
    pub(crate) fn seek(&mut self, inputs: &[&[f32]], input_samples: usize, playback_rate: f64) {
        let length = self.seek_length();
        self.tmp_buffer.clear();
        self.tmp_buffer.resize(length, 0.0);
        let start_index = input_samples.saturating_sub(length);
        let pad_start = length + start_index - input_samples;
        let mut total_energy = 0.0f32;
        for channel in 0..self.channels {
            let input_channel = inputs[channel % inputs.len()];
            for index in start_index..input_samples {
                let sample = input_channel[index];
                total_energy += sample * sample;
                self.tmp_buffer[index - start_index + pad_start] = sample;
            }
            self.stft.write_input(channel, length, &self.tmp_buffer);
        }
        self.stft.move_input(length, false);
        if total_energy >= NOISE_FLOOR {
            self.silence_counter = 0;
            self.silence_first = true;
        }
        self.did_seek = true;
        let interval = self.stft.default_interval() as f32;
        self.seek_time_factor = if playback_rate as f32 * interval > 1.0 {
            1.0 / playback_rate as f32
        } else {
            interval
        };
    }

    /// The main streaming call: consume `input_samples`, produce `output_samples` (the ratio IS the stretch
    /// factor for this span). `inputs: None` reads silence (used by `flush`).
    pub(crate) fn process(&mut self,
                          inputs: Option<&[&[f32]]>,
                          input_samples: usize,
                          outputs: &mut [&mut [f32]],
                          output_samples: usize) {
        self.prev_copied_input = 0;
        let mut total_energy = 0.0f32;
        if let Some(input_channels) = inputs {
            for channel in 0..self.channels {
                let input_channel = input_channels[channel % input_channels.len()];
                for index in 0..input_samples {
                    let sample = input_channel[index];
                    total_energy += sample * sample;
                }
            }
        }
        if total_energy < NOISE_FLOOR {
            if self.silence_counter >= 2 * self.stft.block_samples() {
                if self.silence_first {
                    self.silence_first = false;
                    self.samples_since_last = usize::MAX;
                    for band in self.channel_bands.iter_mut() {
                        band.input = Complex::ZERO;
                        band.prev_input = Complex::ZERO;
                        band.output = Complex::ZERO;
                        band.input_energy = 0.0;
                    }
                }
                if input_samples > 0 {
                    let input_channels = inputs.unwrap_or(&[]);
                    for output_index in 0..output_samples {
                        let input_index = output_index % input_samples;
                        for channel in 0..self.channels {
                            outputs[channel][output_index] =
                                input_channels[channel % input_channels.len()][input_index];
                        }
                    }
                } else {
                    for channel in 0..self.channels {
                        for output_index in 0..output_samples {
                            outputs[channel][output_index] = 0.0;
                        }
                    }
                }
                self.copy_input(inputs, input_samples as i64);
                return;
            }
            self.silence_counter += input_samples;
        } else {
            self.silence_counter = 0;
            self.silence_first = true;
        }
        let interval = self.stft.default_interval();
        for output_index in 0..output_samples {
            if self.samples_since_last >= interval {
                self.samples_since_last = 0;
                let input_offset =
                    math::round(output_index as f64 * input_samples as f64 / output_samples as f64) as i64;
                let input_interval = input_offset - self.prev_input_offset;
                self.prev_input_offset = input_offset;
                self.copy_input(inputs, input_offset);
                let new_spectrum = self.did_seek || input_interval > 0;
                let mapped_frequencies = self.freq_multiplier != 1.0;
                let process_formants = self.formant_multiplier != 1.0
                    || (self.formant_compensation && mapped_frequencies);
                let time_factor = if self.did_seek {
                    self.seek_time_factor
                } else {
                    interval as f32 / input_interval.max(1) as f32
                };
                if new_spectrum {
                    let reanalyse_prev =
                        self.did_seek || (input_interval - interval as i64).abs() > 1;
                    if reanalyse_prev {
                        self.stft.analyse(interval);
                        for channel in 0..self.channels {
                            for band in 0..self.bands {
                                self.channel_bands[channel * self.bands + band].prev_input =
                                    self.stft.spectrum(channel)[band];
                            }
                        }
                    }
                    self.stft.analyse(0);
                    for channel in 0..self.channels {
                        for band in 0..self.bands {
                            self.channel_bands[channel * self.bands + band].input =
                                self.stft.spectrum(channel)[band];
                        }
                    }
                }
                self.did_seek = false;
                self.process_spectrum(new_spectrum, mapped_frequencies, process_formants, time_factor);
                for channel in 0..self.channels {
                    let bands = self.bands;
                    for band in 0..bands {
                        let output = self.channel_bands[channel * bands + band].output;
                        self.stft.spectrum_mut(channel)[band] = output;
                    }
                }
                self.stft.synthesise();
            }
            self.samples_since_last += 1;
            let mut sample = [0.0f32];
            for channel in 0..self.channels {
                self.stft.read_output(channel, 0, 1, &mut sample);
                outputs[channel][output_index] = sample[0];
            }
            self.stft.move_output(1);
        }
        self.copy_input(inputs, input_samples as i64);
        self.prev_input_offset -= input_samples as i64;
    }

    /// Drain the remaining output with zero input. More than one interval computes extra (silent-input)
    /// blocks; the final interval is read with a mirrored subtraction so it tapers exactly to zero.
    pub(crate) fn flush(&mut self, outputs: &mut [&mut [f32]], output_samples: usize, playback_rate: f32) {
        let interval = self.stft.default_interval();
        let output_block = output_samples.saturating_sub(interval);
        if output_block > 0 {
            let virtual_input = (output_block as f32 * playback_rate) as usize;
            self.process(None, virtual_input, outputs, output_block);
        }
        let tail_samples = output_samples - output_block;
        self.tmp_buffer.clear();
        self.tmp_buffer.resize(tail_samples, 0.0);
        self.stft.finish_output(1.0);
        for channel in 0..self.channels {
            self.stft.read_output(channel, 0, tail_samples, &mut self.tmp_buffer);
            for index in 0..tail_samples {
                outputs[channel][output_block + index] = self.tmp_buffer[index];
            }
            self.stft.read_output(channel, tail_samples, tail_samples, &mut self.tmp_buffer);
            for index in 0..tail_samples {
                outputs[channel][output_block + tail_samples - 1 - index] -= self.tmp_buffer[index];
            }
        }
        self.stft.reset(0.1);
        for band in self.channel_bands.iter_mut() {
            band.prev_input = Complex::ZERO;
            band.output = Complex::ZERO;
        }
    }

    /// Move the input position AND pre-compute output so the next `process` samples align to the seek point.
    pub(crate) fn output_seek(&mut self, inputs: &[&[f32]], input_length: usize) {
        self.reset();
        let surplus_input = input_length.saturating_sub(self.input_latency());
        let output_latency = self.output_latency();
        let playback_rate = surplus_input as f32 / output_latency as f32;
        let seek_samples = input_length - surplus_input;
        self.seek(inputs, seek_samples, playback_rate as f64);
        let channels = self.channels;
        let mut preroll = core::mem::take(&mut self.preroll_buffer);
        preroll.clear();
        preroll.resize(output_latency * channels, 0.0);
        {
            let mut channel_slices: Vec<&mut [f32]> = Vec::with_capacity(channels);
            let mut rest = preroll.as_mut_slice();
            for _ in 0..channels {
                let (head, tail) = rest.split_at_mut(output_latency);
                channel_slices.push(head);
                rest = tail;
            }
            let offset_inputs: Vec<&[f32]> = inputs.iter().map(|channel| &channel[seek_samples..]).collect();
            self.process(Some(&offset_inputs), surplus_input, &mut channel_slices, output_latency);
        }
        for value in preroll.iter_mut() {*value = -*value}
        for channel in 0..channels {
            let chunk = &mut preroll[channel * output_latency..(channel + 1) * output_latency];
            chunk.reverse();
            self.stft.add_output(channel, output_latency, chunk);
        }
        self.preroll_buffer = preroll;
    }

    /// One-shot: stretch `input_samples` into exactly `output_samples`, aligned to the start. Returns false
    /// (and zeros the output) when the input is too short to seek.
    pub(crate) fn exact(&mut self,
                        inputs: &[&[f32]],
                        input_samples: usize,
                        outputs: &mut [&mut [f32]],
                        output_samples: usize) -> bool {
        let playback_rate = input_samples as f32 / output_samples as f32;
        let seek_length = self.output_seek_length(playback_rate);
        if input_samples < seek_length {
            for channel in outputs.iter_mut() {
                for value in channel.iter_mut() {*value = 0.0}
            }
            return false;
        }
        self.output_seek(inputs, seek_length);
        let output_index = output_samples - (seek_length as f32 / playback_rate) as usize;
        {
            let offset_inputs: Vec<&[f32]> = inputs.iter().map(|channel| &channel[seek_length..]).collect();
            let mut offset_outputs: Vec<&mut [f32]> = outputs.iter_mut()
                .map(|channel| &mut channel[..output_index])
                .collect();
            self.process(Some(&offset_inputs), input_samples - seek_length, &mut offset_outputs, output_index);
        }
        let mut offset_outputs: Vec<&mut [f32]> = outputs.iter_mut()
            .map(|channel| &mut channel[output_index..])
            .collect();
        self.flush(&mut offset_outputs, output_samples - output_index, playback_rate);
        true
    }

    fn copy_input(&mut self, inputs: Option<&[&[f32]]>, to_index: i64) {
        let max_length = (self.stft.block_samples() + self.stft.default_interval()) as i64;
        let length = max_length.min(to_index - self.prev_copied_input).max(0) as usize;
        if length > 0 {
            let offset = (to_index as usize).saturating_sub(length);
            match inputs {
                Some(input_channels) => {
                    for channel in 0..self.channels {
                        let input_channel = input_channels[channel % input_channels.len()];
                        self.stft.write_input(channel, length, &input_channel[offset..offset + length]);
                    }
                    self.stft.move_input(length, false);
                }
                None => self.stft.move_input(length, true)
            }
        }
        self.prev_copied_input = to_index;
    }

    fn get_input(&self, channel: usize, index: i32) -> Complex {
        if index < 0 || index as usize >= self.bands {
            return Complex::ZERO;
        }
        self.channel_bands[channel * self.bands + index as usize].input
    }

    fn get_prev_input(&self, channel: usize, index: i32) -> Complex {
        if index < 0 || index as usize >= self.bands {
            return Complex::ZERO;
        }
        self.channel_bands[channel * self.bands + index as usize].prev_input
    }

    fn get_input_energy(&self, channel: usize, index: i32) -> f32 {
        if index < 0 || index as usize >= self.bands {
            return 0.0;
        }
        self.channel_bands[channel * self.bands + index as usize].input_energy
    }

    fn fractional_input(&self, channel: usize, input_index: f32) -> Complex {
        let low_index = floor_i32(input_index);
        let fraction = input_index - low_index as f32;
        let low = self.get_input(channel, low_index);
        let high = self.get_input(channel, low_index + 1);
        low.add(high.sub(low).scale(fraction))
    }

    fn fractional_prev_input(&self, channel: usize, low_index: i32, fraction: f32) -> Complex {
        let low = self.get_prev_input(channel, low_index);
        let high = self.get_prev_input(channel, low_index + 1);
        low.add(high.sub(low).scale(fraction))
    }

    fn fractional_energy(&self, channel: usize, low_index: i32, fraction: f32) -> f32 {
        let low = self.get_input_energy(channel, low_index);
        let high = self.get_input_energy(channel, low_index + 1);
        low + (high - low) * fraction
    }

    fn map_freq(&self, freq: f32) -> f32 {
        if freq > self.freq_tonality_limit {
            return freq + (self.freq_multiplier - 1.0) * self.freq_tonality_limit;
        }
        freq * self.freq_multiplier
    }

    fn inv_map_formant(&self, freq: f32) -> f32 {
        if freq * self.inv_formant_multiplier > self.freq_tonality_limit {
            return freq + (1.0 - self.formant_multiplier) * self.freq_tonality_limit;
        }
        freq * self.inv_formant_multiplier
    }

    fn process_spectrum(&mut self, new_spectrum: bool, mapped_frequencies: bool, process_formants: bool, time_factor: f32) {
        let bands = self.bands;
        let channels = self.channels;
        let interval = self.stft.default_interval() as f32;
        let smoothing_bins = self.stft.fft_samples() as f32 / interval;
        let long_vertical_step = math::round(smoothing_bins as f64) as i32;
        let time_factor = time_factor.max(1.0 / MAX_CLEAN_STRETCH);
        let random_time_factor = time_factor > MAX_CLEAN_STRETCH;
        let random_low = MAX_CLEAN_STRETCH * 2.0 * (random_time_factor as u32 as f32) - time_factor;
        let random_high = time_factor;
        if new_spectrum {
            // rotate the previous output/prev-input phases forward by one interval, re-referencing them to
            // the new block time (every bin advances by its own centre frequency)
            let freq0 = self.stft.bin_to_freq(0.0);
            let freq_step = self.stft.bin_to_freq(1.0) - freq0;
            let mut rot = Complex::from_angle(freq0 * interval * math::TAU);
            let rot_step = Complex::from_angle(freq_step * interval * math::TAU);
            for band in 0..bands {
                for channel in 0..channels {
                    let bin = &mut self.channel_bands[channel * bands + band];
                    bin.output = bin.output.mul(rot);
                    bin.prev_input = bin.prev_input.mul(rot);
                }
                rot = rot.mul(rot_step);
            }
        }
        if mapped_frequencies {
            self.smooth_energy(smoothing_bins);
            self.find_peaks();
            self.update_output_map();
        } else {
            for channel in 0..channels {
                for band in 0..bands {
                    let bin = &mut self.channel_bands[channel * bands + band];
                    bin.input_energy = bin.input.norm();
                }
            }
            for band in 0..bands {
                self.output_map[band] = MapPoint {input_bin: band as f32, freq_grad: 1.0};
            }
        }
        if process_formants {
            self.update_formants();
        }
        // preliminary phase-vocoder prediction: continue each output bin by the input's phase advance
        for channel in 0..channels {
            for band in 0..bands {
                let map_point = self.output_map[band];
                let low_index = floor_i32(map_point.input_bin);
                let fraction = map_point.input_bin - low_index as f32;
                let prev_energy = self.predictions[channel * bands + band].energy;
                let energy = self.fractional_energy(channel, low_index, fraction) * map_point.freq_grad.max(0.0);
                let input = {
                    let low = self.get_input(channel, low_index);
                    let high = self.get_input(channel, low_index + 1);
                    low.add(high.sub(low).scale(fraction))
                };
                self.predictions[channel * bands + band] = Prediction {energy, input};
                let prev_input = self.fractional_prev_input(channel, low_index, fraction);
                let freq_twist = input.mul_conj(prev_input);
                let bin = &mut self.channel_bands[channel * bands + band];
                let phase = bin.output.mul(freq_twist);
                bin.output = phase.scale(1.0 / (prev_energy.max(energy) + NOISE_FLOOR));
            }
        }
        // main prediction: blend up to four vertical phase relationships, loudest channel first, others
        // phase-locked to it
        for band in 0..bands {
            let mut max_channel = 0;
            let mut max_energy = self.predictions[band].energy;
            for channel in 1..channels {
                let energy = self.predictions[channel * bands + band].energy;
                if energy > max_energy {
                    max_channel = channel;
                    max_energy = energy;
                }
            }
            let prediction = self.predictions[max_channel * bands + band];
            let map_point = self.output_map[band];
            let mut phase = Complex::ZERO;
            if band > 0 {
                let bin_time_factor = if random_time_factor {
                    random_low + (random_high - random_low) * self.rng.uniform()
                } else {
                    time_factor
                };
                let down_input = self.fractional_input(max_channel, map_point.input_bin - bin_time_factor);
                let short_vertical_twist = prediction.input.mul_conj(down_input);
                let down_output = self.channel_bands[max_channel * bands + band - 1].output;
                phase = phase.add(down_output.mul(short_vertical_twist));
                if band as i32 >= long_vertical_step {
                    let long_down_input = self.fractional_input(
                        max_channel, map_point.input_bin - long_vertical_step as f32 * bin_time_factor);
                    let long_vertical_twist = prediction.input.mul_conj(long_down_input);
                    let long_down_output =
                        self.channel_bands[max_channel * bands + band - long_vertical_step as usize].output;
                    phase = phase.add(long_down_output.mul(long_vertical_twist));
                }
            }
            if band < bands - 1 {
                let up_prediction = self.predictions[max_channel * bands + band + 1];
                let up_map_point = self.output_map[band + 1];
                let bin_time_factor = if random_time_factor {
                    random_low + (random_high - random_low) * self.rng.uniform()
                } else {
                    time_factor
                };
                let down_input = self.fractional_input(max_channel, up_map_point.input_bin - bin_time_factor);
                let short_vertical_twist = up_prediction.input.mul_conj(down_input);
                let up_output = self.channel_bands[max_channel * bands + band + 1].output;
                phase = phase.add(up_output.mul_conj(short_vertical_twist));
                if band + (long_vertical_step as usize) < bands {
                    let long_up_prediction =
                        self.predictions[max_channel * bands + band + long_vertical_step as usize];
                    let long_up_map_point = self.output_map[band + long_vertical_step as usize];
                    let long_down_input = self.fractional_input(
                        max_channel, long_up_map_point.input_bin - long_vertical_step as f32 * bin_time_factor);
                    let long_vertical_twist = long_up_prediction.input.mul_conj(long_down_input);
                    let long_up_output =
                        self.channel_bands[max_channel * bands + band + long_vertical_step as usize].output;
                    phase = phase.add(long_up_output.mul_conj(long_vertical_twist));
                }
            }
            let output = prediction.make_output(phase);
            self.channel_bands[max_channel * bands + band].output = output;
            for channel in 0..channels {
                if channel != max_channel {
                    let channel_prediction = self.predictions[channel * bands + band];
                    let channel_twist = channel_prediction.input.mul_conj(prediction.input);
                    let channel_phase = output.mul(channel_twist);
                    self.channel_bands[channel * bands + band].output =
                        channel_prediction.make_output(channel_phase);
                }
            }
        }
        if new_spectrum {
            for band in self.channel_bands.iter_mut() {
                band.prev_input = band.input;
            }
        }
    }

    fn smooth_energy(&mut self, smoothing_bins: f32) {
        let smoothing_slew = 1.0 / (1.0 + smoothing_bins * 0.5);
        for value in self.energy.iter_mut() {*value = 0.0}
        for channel in 0..self.channels {
            for band in 0..self.bands {
                let bin = &mut self.channel_bands[channel * self.bands + band];
                let energy = bin.input.norm();
                bin.input_energy = energy;
                self.energy[band] += energy;
            }
        }
        self.smoothed_energy.copy_from_slice(&self.energy);
        self.smooth_energy_state = 0.0;
        let mut state = self.smooth_energy_state;
        for _ in 0..2 {
            for band in (0..self.bands).rev() {
                state += (self.smoothed_energy[band] - state) * smoothing_slew;
                self.smoothed_energy[band] = state;
            }
            for band in 0..self.bands {
                state += (self.smoothed_energy[band] - state) * smoothing_slew;
                self.smoothed_energy[band] = state;
            }
        }
        self.smooth_energy_state = state;
    }

    fn find_peaks(&mut self) {
        self.peaks.clear();
        let mut start = 0usize;
        while start < self.bands {
            if self.energy[start] > self.smoothed_energy[start] {
                let mut end = start;
                let mut band_sum = 0.0f32;
                let mut energy_sum = 0.0f32;
                while end < self.bands && self.energy[end] > self.smoothed_energy[end] {
                    band_sum += end as f32 * self.energy[end];
                    energy_sum += self.energy[end];
                    end += 1;
                }
                let avg_band = band_sum / energy_sum;
                let avg_freq = self.stft.bin_to_freq(avg_band);
                self.peaks.push(Peak {
                    input: avg_band,
                    output: self.stft.freq_to_bin(self.map_freq(avg_freq))
                });
                start = end;
            }
            start += 1;
        }
    }

    fn update_output_map(&mut self) {
        let bands = self.bands;
        if self.peaks.is_empty() {
            for band in 0..bands {
                self.output_map[band] = MapPoint {input_bin: band as f32, freq_grad: 1.0};
            }
            return;
        }
        let bottom_offset = self.peaks[0].input - self.peaks[0].output;
        let first_end = (bands as i64).min(math::floor(self.peaks[0].output as f64 + 0.999_999) as i64).max(0) as usize;
        for band in 0..first_end.min(bands) {
            self.output_map[band] = MapPoint {input_bin: band as f32 + bottom_offset, freq_grad: 1.0};
        }
        for peak_index in 1..self.peaks.len() {
            let prev = self.peaks[peak_index - 1];
            let next = self.peaks[peak_index];
            let range_scale = 1.0 / (next.output - prev.output);
            let out_offset = prev.input - prev.output;
            let out_scale = next.input - next.output - prev.input + prev.output;
            let grad_scale = out_scale * range_scale;
            let start_bin = (math::floor(prev.output as f64 + 0.999_999) as i64).max(0) as usize;
            let end_bin = (math::floor(next.output as f64 + 0.999_999) as i64).max(0).min(bands as i64) as usize;
            for band in start_bin..end_bin {
                let range = (band as f32 - prev.output) * range_scale;
                let smooth = range * range * (3.0 - 2.0 * range);
                let grad_smooth = 6.0 * range * (1.0 - range);
                self.output_map[band] = MapPoint {
                    input_bin: band as f32 + out_offset + smooth * out_scale,
                    freq_grad: 1.0 + grad_smooth * grad_scale
                };
            }
        }
        let last = self.peaks[self.peaks.len() - 1];
        let top_offset = last.input - last.output;
        let top_start = (last.output as i64).max(0) as usize;
        for band in top_start.min(bands)..bands {
            self.output_map[band] = MapPoint {input_bin: band as f32 + top_offset, freq_grad: 1.0};
        }
    }

    fn estimate_frequency(&mut self) -> f32 {
        let mut peak_indices = [0usize; 3];
        for band in 1..self.bands.saturating_sub(1) {
            let energy = self.formant_metric[band];
            if energy < self.formant_metric[band - 1] || energy <= self.formant_metric[band + 1] {
                continue;
            }
            if energy > self.formant_metric[peak_indices[0]] {
                if energy > self.formant_metric[peak_indices[1]] {
                    if energy > self.formant_metric[peak_indices[2]] {
                        peak_indices = [peak_indices[1], peak_indices[2], band];
                    } else {
                        peak_indices = [peak_indices[1], band, peak_indices[2]];
                    }
                } else {
                    peak_indices[0] = band;
                }
            }
        }
        let mut peak_estimate = peak_indices[2] as i32;
        if self.formant_metric[peak_indices[1]] > self.formant_metric[peak_indices[2]] * 0.1 {
            let diff = (peak_estimate - peak_indices[1] as i32).abs();
            if diff > peak_estimate / 8 && diff < peak_estimate * 7 / 8 {
                peak_estimate %= diff;
            }
            if self.formant_metric[peak_indices[0]] > self.formant_metric[peak_indices[2]] * 0.01 {
                let diff = (peak_estimate - peak_indices[0] as i32).abs();
                if diff > peak_estimate / 8 && diff < peak_estimate * 7 / 8 {
                    peak_estimate %= diff;
                }
            }
        }
        let weight = self.formant_metric[peak_indices[2]];
        self.freq_estimate_weighted += (peak_estimate as f32 * weight - self.freq_estimate_weighted) * 0.25;
        self.freq_estimate_weight += (weight - self.freq_estimate_weight) * 0.25;
        self.freq_estimate_weighted / (self.freq_estimate_weight + 1e-30)
    }

    fn update_formants(&mut self) {
        let bands = self.bands;
        for value in self.formant_metric.iter_mut() {*value = 0.0}
        for channel in 0..self.channels {
            for band in 0..bands {
                self.formant_metric[band] += self.channel_bands[channel * bands + band].input_energy;
            }
        }
        self.freq_estimate = self.stft.freq_to_bin(self.formant_base_freq);
        if self.formant_base_freq <= 0.0 {
            self.freq_estimate = self.estimate_frequency();
        }
        let mut decay = 1.0 - 1.0 / (self.freq_estimate * 0.5 + 1.0);
        let mut envelope = 0.0f32;
        for _ in 0..2 {
            for band in (0..bands).rev() {
                envelope = self.formant_metric[band].max(envelope * decay);
                self.formant_metric[band] = envelope;
            }
            for band in 0..bands {
                envelope = self.formant_metric[band].max(envelope * decay);
                self.formant_metric[band] = envelope;
            }
        }
        decay = 1.0 / decay;
        for _ in 0..2 {
            for band in (0..bands).rev() {
                envelope = self.formant_metric[band].min(envelope * decay);
                self.formant_metric[band] = envelope;
            }
            for band in 0..bands {
                envelope = self.formant_metric[band].min(envelope * decay);
                self.formant_metric[band] = envelope;
            }
        }
        for band in 0..bands {
            let input_freq = self.stft.bin_to_freq(band as f32);
            let output_freq = if self.formant_compensation {self.map_freq(input_freq)} else {input_freq};
            let output_freq = self.inv_map_formant(output_freq);
            let input_energy = self.formant_metric[band];
            let target_band = self.stft.freq_to_bin(output_freq);
            let target_energy = if target_band < 0.0 {
                0.0
            } else {
                let clamped = target_band.min(bands as f32);
                let floor_band = floor_i32(clamped).max(0) as usize;
                let fraction = clamped - floor_band as f32;
                let low = self.formant_metric[floor_band];
                let high = self.formant_metric[floor_band + 1];
                low + (high - low) * fraction
            };
            let energy_ratio = target_energy / (input_energy + 1e-30);
            for channel in 0..self.channels {
                self.channel_bands[channel * bands + band].input_energy *= energy_ratio;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn sine(length: usize, cycles_per_sample: f32, amplitude: f32) -> vec::Vec<f32> {
        (0..length)
            .map(|index| math::sin(index as f32 * cycles_per_sample * math::TAU) * amplitude)
            .collect()
    }

    fn zero_crossing_rate(samples: &[f32]) -> f32 {
        let mut crossings = 0usize;
        for index in 1..samples.len() {
            if samples[index - 1] < 0.0 && samples[index] >= 0.0 {
                crossings += 1;
            }
        }
        crossings as f32 / samples.len() as f32
    }

    fn rms(samples: &[f32]) -> f32 {
        let sum: f32 = samples.iter().map(|value| value * value).sum();
        sqrt_f32(sum / samples.len() as f32)
    }

    #[test]
    fn exact_double_stretch_preserves_pitch_and_level() {
        let mut stretch = ComplexStretch::new();
        stretch.configure(1, 1024, 256);
        let freq = 0.01; // cycles per sample
        let input = sine(16384, freq, 0.5);
        let mut output = vec![0.0f32; 32768];
        let ok = {
            let mut outputs: vec::Vec<&mut [f32]> = vec![output.as_mut_slice()];
            stretch.exact(&[&input], 16384, &mut outputs, 32768)
        };
        assert!(ok, "input long enough to seek");
        let middle = &output[8192..24576];
        let rate = zero_crossing_rate(middle);
        assert!((rate - freq).abs() / freq < 0.05, "pitch preserved: {rate} vs {freq}");
        let level = rms(middle);
        assert!((level - 0.3535).abs() < 0.08, "level roughly preserved: rms {level}");
    }

    #[test]
    fn exact_compress_preserves_pitch() {
        let mut stretch = ComplexStretch::new();
        stretch.configure(1, 1024, 256);
        let freq = 0.02;
        let input = sine(32768, freq, 0.5);
        let mut output = vec![0.0f32; 16384];
        let ok = {
            let mut outputs: vec::Vec<&mut [f32]> = vec![output.as_mut_slice()];
            stretch.exact(&[&input], 32768, &mut outputs, 16384)
        };
        assert!(ok);
        let middle = &output[4096..12288];
        let rate = zero_crossing_rate(middle);
        assert!((rate - freq).abs() / freq < 0.05, "pitch preserved under compression: {rate} vs {freq}");
    }

    #[test]
    fn transpose_shifts_pitch_up_an_octave() {
        let mut stretch = ComplexStretch::new();
        stretch.configure(1, 1024, 256);
        stretch.set_transpose_semitones(12.0, 0.0);
        let freq = 0.01;
        let input = sine(16384, freq, 0.5);
        let mut output = vec![0.0f32; 16384];
        let ok = {
            let mut outputs: vec::Vec<&mut [f32]> = vec![output.as_mut_slice()];
            stretch.exact(&[&input], 16384, &mut outputs, 16384)
        };
        assert!(ok);
        let middle = &output[4096..12288];
        let rate = zero_crossing_rate(middle);
        let expected = freq * 2.0;
        assert!((rate - expected).abs() / expected < 0.08, "octave up: {rate} vs {expected}");
    }

    #[test]
    fn silence_stays_silent() {
        let mut stretch = ComplexStretch::new();
        stretch.configure(2, 1024, 256);
        let input = vec![0.0f32; 8192];
        let mut left = vec![0.0f32; 8192];
        let mut right = vec![0.0f32; 8192];
        {
            let mut outputs: vec::Vec<&mut [f32]> = vec![left.as_mut_slice(), right.as_mut_slice()];
            stretch.process(Some(&[&input, &input]), 4096, &mut outputs, 8192);
        }
        let peak = left.iter().chain(right.iter()).fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(peak < 1e-6, "silent input renders silence (peak {peak})");
    }
}
