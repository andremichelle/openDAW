# Generates the stage reference vectors by running Matchering 2.0.6 itself on synthetic audio.
# Requires numpy, scipy, statsmodels and matchering (pip install --no-deps matchering).
# The audio is a formula the Rust test reproduces, so only the results are stored.
import os
import sys
import numpy as np
import scipy.ndimage

sys.modules["scipy.ndimage.filters"] = scipy.ndimage  # removed in recent scipy, only the limiter imports it
from matchering import Config
from matchering import stages
from matchering.stage_helpers import match_levels, match_frequencies

here = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 44100
MASK = (1 << 64) - 1


def noise(seed, count):
    z = (np.uint64(seed) + np.arange(count, dtype=np.uint64) * np.uint64(0x9E3779B97F4A7C15)) & np.uint64(MASK)
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    z = z ^ (z >> np.uint64(31))
    return (z >> np.uint64(11)).astype(np.float64) / float(1 << 53) * 2.0 - 1.0


def signal(seconds, seed, tones, noise_level):
    count = int(seconds * SAMPLE_RATE)
    t = np.arange(count, dtype=np.float64) / SAMPLE_RATE
    envelope = 0.5 + 0.4 * np.sin(2.0 * np.pi * 0.07 * t)
    channels = []
    for channel in range(2):
        voice = sum(level * np.sin(2.0 * np.pi * frequency * t + channel * 0.3) for frequency, level in tones)
        channels.append(envelope * (voice + noise_level * noise(seed + channel, count)))
    return np.stack(channels, axis=1)


def save(name, array):
    np.asarray(array, dtype="<f8").tofile(os.path.join(here, f"{name}.bin"))


target = signal(40.0, 7, [(110.0, 0.3), (440.0, 0.2)], 0.15)
reference = signal(35.0, 11, [(80.0, 0.4), (2000.0, 0.25)], 0.1)
config = Config()

normalized, final_amplitude = match_levels.normalize_reference(reference, config)
_, _, mid_loudest, side_loudest, match_rms, *_ = match_levels.analyze_levels(normalized, "reference", config)
average_fft = getattr(match_frequencies, "__average_fft")
save("profile_scalars", [match_rms, final_amplitude])
save("profile_mid_spectrum", average_fft(mid_loudest, config.internal_sample_rate, config.fft_size))
save("profile_side_spectrum", average_fft(side_loudest, config.internal_sample_rate, config.fft_size))

target_mid, target_side, _, target_mid_loudest, target_side_loudest, reference_mid_loudest, reference_side_loudest, \
    *_ = getattr(stages, "__match_levels")(target, reference, config)
smooth = getattr(match_frequencies, "__smooth_exponentially")
for name, target_pieces, reference_pieces in [("mid", target_mid_loudest, reference_mid_loudest),
                                              ("side", target_side_loudest, reference_side_loudest)]:
    target_fft = np.maximum(config.min_value, average_fft(target_pieces, config.internal_sample_rate, config.fft_size))
    reference_fft = average_fft(reference_pieces, config.internal_sample_rate, config.fft_size)
    save(f"match_{name}_curve", smooth(reference_fft / target_fft, config))

_, result, _ = stages.main(target, reference, config, need_default=False, need_no_limiter=True)
save("match_result_decimated", result[::997].reshape(-1))
