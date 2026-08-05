# Neon calibration probes

Each `.syx` isolates ONE mapping. Every file has its VirtualCZ reference render (`<name>.wav`,
headless via pedalboard, 48k stereo) next to it, following the note plan below: a single held C4 for
the listed duration unless stated otherwise, then release with one extra second of ring.

- `dca-rate-fast.syx` — C4, hold 6s — DCA rate curve 60-95: segment times between alternating levels
- `dca-rate-mid.syx` — C4, hold 20s — DCA rate curve 30-55
- `dca-rate-slow.syx` — C4, hold 90s (long!) — DCA rate curve 15-25
- `dca-level.syx` — C4, hold 8s — DCA level→amplitude curve: plateaus at 90..20
- `dcw-level.syx` — C4, hold 8s — DCW level→brightness curve: plateaus at 90..20 (saw)
- `dcw-sweep-saw.syx` — C4, hold 12s — wave 1 morphology over a slow DCW ramp 0→99
- `dcw-sweep-square.syx` — C4, hold 12s — wave 2 morphology over a slow DCW ramp 0→99
- `dcw-sweep-pulse.syx` — C4, hold 12s — wave 3 morphology over a slow DCW ramp 0→99
- `dcw-sweep-double-sine.syx` — C4, hold 12s — wave 4 morphology over a slow DCW ramp 0→99
- `dcw-sweep-saw-pulse.syx` — C4, hold 12s — wave 5 morphology over a slow DCW ramp 0→99
- `dcw-sweep-res-saw.syx` — C4, hold 12s — wave 6 morphology over a slow DCW ramp 0→99
- `dcw-sweep-res-triangle.syx` — C4, hold 12s — wave 7 morphology over a slow DCW ramp 0→99
- `dcw-sweep-res-trapezoid.syx` — C4, hold 12s — wave 8 morphology over a slow DCW ramp 0→99
- `vib-rate-5.syx` — C4, hold 8s — vibrato LFO frequency at this rate value
- `vib-rate-25.syx` — C4, hold 8s — vibrato LFO frequency at this rate value
- `vib-rate-50.syx` — C4, hold 8s — vibrato LFO frequency at this rate value
- `vib-rate-75.syx` — C4, hold 8s — vibrato LFO frequency at this rate value
- `vib-rate-99.syx` — C4, hold 8s — vibrato LFO frequency at this rate value
- `vib-depth-10.syx` — C4, hold 8s — vibrato depth in cents at this depth value (rate fixed 30)
- `vib-depth-30.syx` — C4, hold 8s — vibrato depth in cents at this depth value (rate fixed 30)
- `vib-depth-60.syx` — C4, hold 8s — vibrato depth in cents at this depth value (rate fixed 30)
- `vib-depth-99.syx` — C4, hold 8s — vibrato depth in cents at this depth value (rate fixed 30)
- `vib-delay-60.syx` — C4, hold 10s — vibrato delay/ramp time at delay 60 (rate 40, depth 60)
- `ring-sine.syx` — C4, hold 6s — RING formula: pure cosines (DCW 0) at f and f/2 — sideband levels read the mix
- `ring-bright.syx` — C4, hold 6s — RING with full-DCW saws (rich case cross-check)
- `noise-mod.syx` — C4, hold 6s — NOISE modulation on pure cosines
- `alternation.syx` — C4, hold 6s — wave1+wave2 on ONE line (square+saw): per-cycle alternation vs other semantics
- `kf-dca-9.syx` — C2 2s, C4 2s, C6 2s — DCA key follow 9: envelope speed vs note
- `kf-dcw-9.syx` — C2 2s, C4 2s, C6 2s — DCW key follow 9: brightness vs note (saw, DCW 99)
- `pitch-level.syx` — C4, hold 10s — DCO pitch-env level→pitch curve: plateaus at 10..99
