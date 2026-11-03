# A/B tool, Matchering side: runs Matchering 2.0.6 on two 44.1 kHz WAV files and writes into the output folder
#   matchering_raw.wav      the result without limiter (float)
#   matchering_limited.wav  the result with Matchering's limiter (float)
#   matchering_curves.bin   the unlimited mid and side matching curves (2049 + 2049 little endian f64)
# Requires numpy, scipy, statsmodels, soundfile and matchering (pip install --no-deps matchering).
# Usage: python3 compare.py target.wav reference.wav out-folder (or run compare.sh for both sides)
import os
import sys
import numpy as np
import scipy.ndimage
import soundfile

sys.modules["scipy.ndimage.filters"] = scipy.ndimage  # removed in recent scipy, only the limiter imports it
import matchering
from matchering import Config
from matchering import stages
from matchering.stage_helpers import match_frequencies

target_path, reference_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
for path in (target_path, reference_path):
    if soundfile.info(path).samplerate != 44100:
        sys.exit(f"{path} is not 44.1 kHz, resample it first so both sides read the same samples")

matchering.process(target=target_path, reference=reference_path, results=[
    matchering.Result(os.path.join(out, "matchering_raw.wav"), "FLOAT", use_limiter=False, normalize=False),
    matchering.Result(os.path.join(out, "matchering_limited.wav"), "FLOAT", use_limiter=True)
])


def stereo(path):
    sound, _ = soundfile.read(path, always_2d=True)
    return np.repeat(sound, 2, axis=1) if sound.shape[1] == 1 else sound[:, :2]


config = Config()
target, reference = stereo(target_path), stereo(reference_path)
*_, mid_loudest, side_loudest, ref_mid_loudest, ref_side_loudest, _, _, _ = \
    getattr(stages, "__match_levels")(target, reference, config)
average_fft = getattr(match_frequencies, "__average_fft")
smooth = getattr(match_frequencies, "__smooth_exponentially")
curves = []
for target_pieces, reference_pieces in [(mid_loudest, ref_mid_loudest), (side_loudest, ref_side_loudest)]:
    target_fft = np.maximum(config.min_value, average_fft(target_pieces, config.internal_sample_rate, config.fft_size))
    reference_fft = average_fft(reference_pieces, config.internal_sample_rate, config.fft_size)
    curves.append(smooth(reference_fft / target_fft, config))
np.asarray(np.concatenate(curves), dtype="<f8").tofile(os.path.join(out, "matchering_curves.bin"))
print(f"matchering: wrote {out}")
