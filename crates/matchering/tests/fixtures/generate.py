# Generates the reference vectors for the Rust tests with the libraries Matchering uses.
# Requires numpy, scipy and statsmodels. Run: python3 generate.py (writes the .bin files next to it).
import os
import numpy as np
import statsmodels.api as sm
from scipy import interpolate

here = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(515)


def save(name, array):
    np.asarray(array, dtype="<f8").tofile(os.path.join(here, f"{name}.bin"))


def lowess(y, frac, it, delta):
    return sm.nonparametric.lowess(y, np.linspace(0, 1, len(y)), frac=frac, it=it, delta=delta)[:, 1]


def matching_curve(size):
    x = np.linspace(0, 1, size)
    return 1.0 + 0.4 * np.sin(x * 9.0) + 0.3 * np.exp(-x * 6.0) + rng.normal(0.0, 0.15, size)


small = matching_curve(500)
save("lowess_small_input", small)
save("lowess_small_plain", lowess(small, 0.1, 0, 0.0))
save("lowess_small_robust", lowess(small, 0.1, 2, 0.01))

fft_size, sample_rate, oversampling = 4096, 44100, 4
grid_linear = sample_rate * 0.5 * np.linspace(0, 1, fft_size // 2 + 1)
grid_logarithmic = sample_rate * 0.5 * np.logspace(np.log10(4 / fft_size), 0, (fft_size // 2) * oversampling + 1)
spectrum = np.abs(matching_curve(len(grid_linear)))
save("spline_input", spectrum)
spectrum_log = interpolate.interp1d(grid_linear, spectrum, "cubic")(grid_logarithmic)
save("spline_linear_to_log", spectrum_log)
smoothed = lowess(spectrum_log, 0.0375, 0, 0.001)
save("lowess_matchering", smoothed)
save("spline_log_to_linear",
     interpolate.interp1d(grid_logarithmic, smoothed, "cubic", fill_value="extrapolate")(grid_linear))
