# Match Tempo — `/tap` Page

## Goal

A standalone page at `/tap` that lets the user synchronise the openDAW project to an external, continuously-playing source (typically a DJ vinyl) without knowing its BPM in advance. The user taps a large button in time with the external beat. The system estimates the BPM and phase from the taps, starts playback on the 5th tap, and from then on continuously resyncs the engine to the tapped beat — like a DJ riding the pitch fader on a turntable.

The external source is assumed to have a **fixed BPM** (which may be any float value). The system never has direct access to that BPM; the only signal is the user's taps.

## User flow

| Tap count | State | Behaviour |
|-----------|-------|-----------|
| 0         | idle      | Big button labelled "TAP". |
| 1         | measuring | First tap recorded. Nothing visible yet (no interval). |
| 2-4       | measuring | Running BPM estimate displayed below the button. |
| 5         | start     | Engine seeks to position 0 (bar 1, beat 1), playback starts. This tap *is* beat 1. |
| 6+        | running   | Every tap is interpreted as "the external music is on a beat right now". The engine BPM and phase are continuously pulled toward the tap stream. |

There is no separate "measuring" vs "running" algorithm. Taps 1-4 simply fill the estimator's buffer; tap 5 launches the transport and anchors the phase reference; tap 6+ refine the same estimator. The algorithm is uniform.

A reset control returns to `idle` (clears the buffer; engine may keep playing on the last estimate or stop, see open question).

## Algorithm

### What we are estimating

Two quantities, jointly:

- **period**: milliseconds per beat (→ `bpm = 60000 / period`)
- **t0**: wall-clock time (`performance.now()`) of the reference beat (beat number 0)

Every tap is a measurement of the form: "*at wall-clock time `t_k`, the external music is on integer beat number `n_k`*". From a stream of such measurements, we fit a line.

### Sliding-window linear regression on absolute tap times

Maintain a ring buffer of the last `K` taps (K = 8 to start), each stored as `(t_k, n_k)`. On each new tap:

1. **Assign a beat number `n_new`** by snapping the predicted fractional beat at `t_new` to the nearest integer under the current model:
   ```
   predicted = (t_new - t0) / period
   n_new     = round(predicted)
   residual  = predicted - n_new            // signed, in beats
   ```
2. **Outlier / re-anchor check:** if `|residual| > 0.35`, the tap is too far from the predicted grid to trust as a small correction. Treat it as a re-anchor: clear the buffer, set `t0 = t_new`, `n_new = 0`, keep `period` unchanged. This handles "user stopped tapping for a long time and the grid has drifted", "user mis-tapped", and the initial bootstrap (the first tap into an empty buffer re-anchors trivially).
3. **Insert** `(t_new, n_new)` into the ring buffer.
4. **Refit** by ordinary least squares on the buffer contents:
   ```
   slope (period)     = Σ((n_k - n̄)(t_k - t̄)) / Σ((n_k - n̄)²)
   intercept (t0)     = t̄ - slope · n̄
   ```
   With one tap in the buffer, slope is undefined → period unchanged. With two taps, slope = simple interval (period bootstrapped here). With ≥3 taps, OLS smooths.
5. **Residual norm** of the fit (RMS of `t_k - (t0 + slope·n_k)`) is exposed as a confidence signal. Future enhancement: dampen the engine pull when residuals are large (user is tapping unevenly), tighten it when residuals are small (user is locked in).

### Why this is better than EMA-on-intervals

- A single late tap perturbs the fit by ≈ 1/K of its error, not by α (typically 0.1–0.3 in EMA). Estimate stays smooth even with shaky tapping.
- Uses absolute tap *times*, not deltas. Jitter doesn't compound across taps.
- `period` and `t0` fall out of **one** estimator. The phase reference and the tempo are always consistent (they come from the same line).
- The fit residual gives a free confidence signal.
- One intuitive knob: `K`. Larger K → smoother, slower to respond; smaller K → snappier, jitterier. For a truly fixed-BPM vinyl, K can lean larger (8-16).
- Built-in lock-loss via the residual threshold. No separate "gap > 8 beats" rule needed.

### Applying the fit to the engine — the vinyl ride

The fit changes only when a tap arrives. Between taps, the engine has to keep playing smoothly. Two mechanisms run continuously in a `requestAnimationFrame` loop while playback is active:

- **`baseBpm`** — a low-pass-filtered version of the fit's BPM. Each frame:
  ```
  targetBpm = 60000 / fit.period
  baseBpm  += (targetBpm - baseBpm) * (1 - exp(-dt / τ_base))
  ```
  with `τ_base ≈ one beat`. This is the "hand on the pitch fader" — the underlying rate eases toward the fit rather than snapping. Since the fit is already smooth, the eased target is doubly smooth.

- **`bend`** — a short-lived additive BPM offset that aligns the audible phase. On every frame:
  ```
  expectedPos = (now - fit.t0) / fit.period            // beats the engine *should* be at
  actualPos   = engine.position (converted to beats)
  phaseErr    = expectedPos - actualPos                // signed, in beats
  bend        = K_phase * phaseErr * baseBpm           // BPM units
  bend        = clamp(bend, ±0.03 * baseBpm)           // max ±3 %
  ```
  `bend` decays naturally because as soon as the engine catches up, `phaseErr → 0`. No explicit decay constant needed — it's a proportional controller.

- **Effective BPM written to the engine** each frame:
  ```
  effective = baseBpm + bend
  if |effective - lastWritten| > ε:
      project.editing.modify(() => timelineBox.bpm.setValue(effective), false)
  ```
  The `false` is critical: it writes the value without marking the project dirty and without producing undo entries. Pattern is established in the codebase (e.g. `packages/app/studio/src/ui/timeline/editors/audio/WarpMarkerEditing.ts:166`).

The "well-balanced mixture" the user asked for emerges from the relative gains: `τ_base` controls how aggressively the underlying rate retunes; `K_phase` controls how hard each tap-induced phase error gets pushed back. Starting values: `τ_base = 60000 / baseBpm` (one beat), `K_phase = 0.5`, clamp 3 %.

### Tap 5 — starting playback

When the fifth tap arrives:

1. The fit already has 4 prior data points; tap 5 is the 5th and triggers playback.
2. Set the project BPM directly (one-time, `mark: false`): `timelineBox.bpm.setValue(60000 / fit.period)`.
3. Set `t0` so that `n_5` corresponds to engine position 0 (bar 1, beat 1):
   ```
   t0 = t_5                 // tap 5 is beat 0 in our numbering
   ```
4. `engine.setPosition(0)`.
5. `engine.play()`.
6. Initialise `baseBpm = 60000 / fit.period`, `bend = 0`.
7. Start the rAF loop.

Tap 6 onward feeds the fit identically to taps 1-4. The buffer continues to grow up to `K`, then rolls over.

### Bootstrap edge cases

- **Tap 1**: buffer empty → re-anchor (`t0 = t_1`, `n_1 = 0`). Period unknown.
- **Tap 2**: buffer has one point. With two points OLS reduces to the simple interval; `period` is now defined.
- **Tap 3-4**: OLS smooths over 2-3 intervals.
- **Tap 5**: start playback as above. From this tap on, `bend`/`baseBpm` machinery is live.

### Outlier rejection details

The 0.35-beat residual threshold is in **beat space**, so it's tempo-independent. It catches:
- Drop-outs (user got distracted, taps land on the wrong beat).
- Subdivision flips (user accidentally taps every half-beat or every 2 beats — the new interval will be ≈ 0.5 or 2× the period, fractional beat ≈ 0.5 → re-anchor instead of corrupting the fit).
- Long pauses where cumulative drift has thrown the prediction off.

Re-anchoring loses the BPM history? No — `period` is kept, only `t0` and the buffer are reset. So tempo continues; only phase re-locks to the new tap.

## Files

### New
- `packages/app/studio/src/ui/pages/TapTempoPage.tsx` — page component (route factory).
- `packages/app/studio/src/ui/pages/TapTempoPage.sass` — page styles.

### Modified
- `packages/app/studio/src/ui/App.tsx` — add `{path: "/tap", factory: TapTempoPage}` to the routes array (around line 70).

No engine, core, or box changes. Everything sits in the page.

## Component structure

```
TapTempoPage
├─ BackButton
├─ <h1>Match Tempo</h1>
├─ TapButton              (big, covers most of the viewport)
└─ readout                (BPM, tap count, state, residual; small while measuring, large while running)
```

Internal state (kept in closures / refs in the page factory):

```
ringBuffer: Array<{t: number, n: number}>     // up to K entries
period:     number                              // ms per beat, undefined until tap 2
t0:         number                              // wall-clock ms of beat 0
baseBpm:    number                              // smoothed, used while playing
bend:       number                              // additive BPM offset, used while playing
rafHandle:  number | null
state:      "idle" | "measuring" | "running"
```

Use `DefaultObservableValue<...>` for fields that drive the UI readout (BPM, tap count, state).

## Input handling

- Trigger on **`pointerdown`**, not `click`, for the lowest possible latency to `performance.now()`.
- Also bind `Space` to the same handler while the page has focus, so a laptop user can tap with the keyboard.
- Debounce: ignore any tap within 80 ms of the previous one (catches double-fires from a hardware button).
- Maximum interval guard: an interval > 4 seconds (i.e. < 15 BPM) → treat as re-anchor regardless of residual.

## Engine integration

- `service.engine.play()`, `service.engine.stop()`, `service.engine.setPosition(ppqn)`.
- `service.engine.position` (observable) — used in the rAF loop to compute `phaseErr`.
- `service.project.timelineBox.bpm.setValue(b)` wrapped in `project.editing.modify(..., false)` to avoid undo pollution.
- Conversion: engine position is in ppqn. `beatsFromPosition = position / PPQN.Quarter`. To convert wall-clock to engine position we use `t0 + beats * period` for prediction and the engine's own `position` observable for actuality.

## Lifecycle

The page's `Terminator` (from `PageContext`) owns:

- The `pointerdown` and `keydown` listeners.
- The rAF loop (`cancelAnimationFrame` in the disposer).
- Any observable subscriptions on `engine.position` / `engine.isPlaying`.

Leaving the page does **not** auto-stop playback — the user can navigate back to the workspace while the project keeps playing at the matched tempo. The BPM value written to the timeline persists (it is unmarked, so it doesn't dirty the project, but it does take effect).

## Tunable parameters (starting values)

| Symbol      | Value           | Meaning |
|-------------|-----------------|---------|
| `K`         | 8               | Sliding-window size for OLS fit. |
| `τ_base`    | `60000 / baseBpm` ms | Time constant of base-BPM low-pass (one beat). |
| `K_phase`   | 0.5             | Proportional gain on phase error → bend. |
| `bend_max`  | 0.03 · baseBpm  | Hard clamp on bend (±3 %). |
| `outlier`   | 0.35 beats      | Re-anchor threshold (fractional beat distance). |
| `debounce`  | 80 ms           | Min interval between accepted taps. |
| `gap_max`   | 4000 ms         | Force re-anchor if previous tap is older than this. |
| `writeEps`  | 0.001 BPM       | Min change to push a new `bpm.setValue` write. |

All exposed as constants near the top of the file for easy tuning.

## Open questions

1. **Page chrome.** Default: keep `Header`/`Footer` to match other pages. Could go full-screen for phone-in-hand use later.
2. **Reset behaviour.** On manual reset, default: stop the engine and return to `idle`. Alternative: keep playing on the last `baseBpm`, just clear the buffer.

## Why these algorithm choices, briefly

- **Line-fit over EMA**: noise rejection. Tap variance is the dominant noise, fit averages it out across K taps without conflating it with real BPM changes (of which there are none for vinyl).
- **`mark: false`**: per-frame writes would otherwise destroy the undo stack.
- **Proportional phase controller without explicit decay**: the closed loop (engine position ↔ phase error) is self-decaying. Simpler than maintaining an exponential decay on `bend`.
- **Residual-based re-anchor**: handles long pauses, mis-taps, and subdivision flips uniformly with no special-case timers.

## Out of scope (possible future enhancements)

- Subdivision detection (user tapping half- or double-time).
- Residual-driven adaptive gains (slower correction when user is sloppy).
- Audio-onset detection as an alternative input source.
- MIDI-clock output so external gear can lock to the matched tempo.
