# Generates the limiter reference by running Matchering 2.0.6's Hyrax limiter on synthetic audio.
# Requires numpy, scipy, statsmodels and matchering (pip install --no-deps matchering), see
# crates/matchering/tests/fixtures/generate_stages.py. The Rust test reproduces the audio from the same formula.
import os
import sys
import numpy as np
import scipy.ndimage

sys.modules["scipy.ndimage.filters"] = scipy.ndimage  # removed in recent scipy
from matchering import Config
from matchering.limiter import limit

here = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 44100

t = np.arange(10 * SAMPLE_RATE, dtype=np.float64) / SAMPLE_RATE
envelope = 0.6 + 0.9 * np.abs(np.sin(2.0 * np.pi * 0.3 * t))
left = envelope * np.sin(2.0 * np.pi * 440.0 * t)
right = envelope * 0.8 * np.sin(2.0 * np.pi * 330.0 * t + 0.5)
result = limit(np.stack([left, right], axis=1), Config())
np.asarray(result[::97].reshape(-1), dtype="<f8").tofile(os.path.join(here, "hyrax_decimated.bin"))
