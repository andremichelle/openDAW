# Formular — Scripting DSP Device with Spectrum Analyser

## Concept

An educational device where students write DSP code and see the frequency/harmonic response in a connected spectrum analyser. Inspired by Plugin Doctor's static response analysis.

Built on top of the [Werkstatt](werkstatt.md) — same Processor class contract, same parameter system, same worklet integration. Formular adds an onboard analyser that runs measurement signals through the user's code and visualises the results.

## Analysis Techniques

### For Linear Systems (filters, EQs)

**Impulse Response → FFT**
- Send a Dirac impulse (single sample at 1.0, rest zeros) through the user's code
- Capture the output (impulse response)
- FFT the IR: magnitude → frequency response, phase → phase response
- One-shot, perfectly static, mathematically exact
- This works because a Dirac impulse has equal energy at all frequencies

### For Nonlinear Systems (distortion, compression, waveshaping)

Impulse method breaks down because the output depends on signal level.

**1. Logarithmic Swept Sine (Farina method, 2000)**
- Generate a log sweep from 20 Hz to Nyquist over N seconds
- Pass through the system, capture output
- Deconvolve: inverse-FFT of `Output(f) / Input(f)`
- Log sweep's special property: harmonic distortion products arrive at different times in the IR, separating cleanly
- Result: linear frequency response AND individual harmonic distortion orders (2nd, 3rd, 4th...) from a single measurement
- This is what Plugin Doctor primarily uses

**2. Single-Tone Harmonic Analysis (THD)**
- Send a pure sine at frequency f
- FFT the output
- Measure energy at f, 2f, 3f, 4f...
- Shows the harmonic series the nonlinearity generates
- Very visual for students — they can see how waveshaping creates overtones

**3. Two-Tone Intermodulation (IMD)**
- Send two sines at f1 and f2
- Look for new frequencies at f1±f2, 2f1±f2, etc. in the output
- Demonstrates how nonlinearities create frequencies that weren't in the input

**4. Level-Dependent Frequency Response**
- Run impulse or sweep at multiple input levels, overlay curves
- Shows how behaviour changes with level (e.g. compressor flattening)

## Proposed Device Architecture

- **Code editor**: student writes DSP code (init + process functions) — inherited from Werkstatt
- **Mode 1 — Impulse**: Dirac → FFT → frequency + phase response (filters)
- **Mode 2 — Single tone**: adjustable frequency sine → FFT → harmonic spectrum (distortion)
- **Mode 3 — Swept sine**: log chirp → deconvolution → linear IR + harmonic separation (advanced)
- **Spectrum display**: magnitude in dB vs frequency (log scale)

Mode 1 and 2 cover 90% of educational value. Mode 3 (Farina) is the advanced showpiece.

## Open Questions

- Does the analyser run in the worklet (offline, feeding test signals through the user's Processor) or on the main thread?
- How does the analyser interact with live audio? Does it pause live processing to run measurements, or run a separate Processor instance?
- FFT implementation: use an existing library or implement a basic radix-2 FFT?
- Display: Canvas 2D or WebGL for the spectrum plot?
