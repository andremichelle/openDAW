# Werkstatt

A programmable audio effect that lets you write custom DSP code in JavaScript. Define your own signal processing, declare parameters with knobs, and hot-reload changes in real time.

---

![screenshot](werkstatt.webp)

---

## 0. Overview

_Werkstatt_ is a scriptable audio effect device. You write a `Processor` class in JavaScript that receives stereo audio buffers and outputs processed audio sample by sample. Parameters declared in the code appear as automatable knobs on the device panel.

Example uses:

- Custom distortion or waveshaping
- Experimental stereo effects
- Granular or glitch processing
- Ring modulation
- Prototyping new effect ideas

---

## 1. Editor

Click the **Editor** button on the device panel to open the full-screen code editor. The editor uses Monaco (the engine behind VS Code) with JavaScript syntax highlighting.

The status bar at the bottom shows the current state:

- **Idle** — No compilation attempted yet
- **Successfully compiled** — Code compiled and loaded into the audio engine
- **Error message** — Syntax error or runtime error details

---

## 2. Parameters

Declare parameters using `// @param` comments at the top of your code:

```javascript
// @param gain 1.0
// @param cutoff 1000 20 20000 exp Hz
// @param mode 0 0 3 int
// @param bypass false
```

Each `@param` directive creates an automatable knob on the device panel. The full syntax is:

```
// @param <name> [default] [min max type [unit]]
```

### Simple (unipolar)

```
// @param gain           → 0–1, default 0
// @param gain 0.5       → 0–1, default 0.5
```

The knob value and `paramChanged` value are in the 0–1 range.

### Mapped

```
// @param cutoff 1000 20 20000 exp Hz    → exponential 20–20000, default 1000
// @param time 500 1 2000 linear ms      → linear 1–2000, default 500
// @param mode 0 0 3 int                 → integer 0–3, default 0
```

The knob displays the mapped value with the unit. `paramChanged` receives the mapped value directly — no manual scaling needed.

### Boolean

```
// @param bypass false         → Off/On, default Off
// @param bypass true          → Off/On, default On
// @param bypass bool          → Off/On, default Off
```

`paramChanged` receives `0` or `1`.

### Supported mapping types

| Type | Description | paramChanged receives |
|---|---|---|
| *(none)* | Unipolar 0–1 | `number` (0–1) |
| `linear` | Linear scaling between min and max | `number` (min–max) |
| `exp` | Exponential scaling (for frequency, time) | `number` (min–max) |
| `int` | Integer snapping between min and max | `number` (integer) |
| `bool` | On/Off toggle | `number` (0 or 1) |

Parameters are reconciled on each compile: new parameters are added, removed parameters are deleted, and existing parameters keep their current value. Multiple spaces between tokens are allowed for alignment.

---

## 3. Keyboard Shortcuts

| Shortcut            | Action                              |
|---------------------|-------------------------------------|
| `Alt+Enter`         | Compile and run                     |
| `Ctrl+S` / `Cmd+S` | Compile, run, and save to project   |

---

## 4. Safety

The engine validates your output on every audio block:

- **NaN detection** — If any output sample is NaN, the processor is silenced and the error is reported.
- **Overflow protection** — If any sample exceeds ~60 dB (amplitude > 1000), the processor is silenced.
- **Runtime errors** — If `process()` throws an exception, the processor is silenced and the error is shown.

When silenced, the device outputs silence until the next successful compile.

---

## 5. API Reference

Your code must define a `class Processor` with a `process` method. Optionally implement `paramChanged` to receive parameter updates.

### Globals

| Variable     | Type     | Description                              |
|--------------|----------|------------------------------------------|
| `sampleRate` | `number` | Audio sample rate in Hz (e.g. 44100, 48000) |

### Processor class

```javascript
class Processor {
    process(io, block) {
        // io.src[0], io.src[1] — input Float32Arrays (left, right)
        // io.out[0], io.out[1] — output Float32Arrays (left, right)
        //
        // block.s0    — first sample index to process (inclusive)
        // block.s1    — last sample index to process (exclusive)
        // block.index — block counter (increments each audio callback)
        // block.bpm   — current project tempo in beats per minute
        // block.p0    — start position in ppqn (pulses per quarter note, 480 ppqn)
        // block.p1    — end position in ppqn
        // block.flags — bitmask:
        //   1 (transporting) — transport is active
        //   2 (discontinuous) — position jumped (seek, loop restart)
        //   4 (playing)       — playback is active
        //   8 (bpmChanged)    — tempo changed this block
    }
    paramChanged(label, value) {
        // label — string matching the @param name
        // value — number between 0.0 and 1.0
    }
}
```

---

## 6. Examples

Select **Examples** in the code editor toolbar to load ready-made processors (Hard Clipper, Ring Modulator, Simple Delay, Biquad Lowpass).

---

## 7. AI Prompt

Copy the following prompt into an AI assistant to get help writing Werkstatt processors:

```
You are helping the user write a DSP processor for the openDAW Werkstatt audio effect.
The user writes plain JavaScript (no imports, no modules). The code runs inside an AudioWorklet.

The code MUST define a class called `Processor` with the following interface:

class Processor {
    process(io, block) { }       // required
    paramChanged(label, value) { } // optional
}

## process(io, block)
Called on every audio block. Must fill the output buffers between s0 and s1.

io (audio buffers):
- io.src[0] — Float32Array, left input channel
- io.src[1] — Float32Array, right input channel
- io.out[0] — Float32Array, left output channel (write to this)
- io.out[1] — Float32Array, right output channel (write to this)

block (timing and transport):
- block.s0    — first sample index to process (inclusive)
- block.s1    — last sample index to process (exclusive)
- block.index — block counter (increments each audio callback)
- block.bpm   — current project tempo in beats per minute
- block.p0    — start position in ppqn (pulses per quarter note, 480 ppqn)
- block.p1    — end position in ppqn
- block.flags — bitmask of transport state:
    1 = transporting (transport is active)
    2 = discontinuous (position jumped, e.g. seek or loop restart)
    4 = playing (playback is active)
    8 = bpmChanged (tempo changed this block)

You MUST only read/write indices from s0 to s1 (exclusive). Do NOT assume the arrays
start at index 0 or that the full length is available.
Use block.bpm and block.p0/p1 for tempo-synced effects. Use block.flags to detect
transport state changes (e.g. reset phase on discontinuous).

## paramChanged(label, value)
Called when a parameter knob changes value.

- label — string, matches the name from the @param comment
- value — the mapped value (number). For unipolar: 0.0–1.0. For linear/exp: min–max.
  For int: integer in min–max. For bool: 0 or 1.

## Declaring parameters
Parameters are declared as comments at the top of the file:

// @param <name> [default] [min max type [unit]]

Supported types: linear, exp, int, bool.
If no type is given, the parameter is unipolar (0–1).
If the default is "true" or "false", the type is bool.
Multiple spaces between tokens are allowed for alignment.

Each @param creates an automatable knob on the device UI.

Examples:
// @param gain 1.0
// @param cutoff  1000  20  20000  exp  Hz
// @param mode    0     0   3      int
// @param bypass  false

## Globals
- sampleRate — number, the audio sample rate in Hz (e.g. 44100, 48000).
  Always use this instead of hardcoding a sample rate.

## Constraints
- Output is validated every block. NaN or amplitudes > 1000 will silence the processor.
- Do not use import/export/require. No access to DOM or fetch.
- The code runs in an AudioWorklet thread. Only AudioWorklet-safe APIs are available
  (Math, typed arrays, basic JS). No console, no setTimeout, no DOM.
- You can define and use helper classes alongside the Processor class.
- NEVER allocate memory inside process(). No `new`, no array literals, no object
  literals, no string concatenation, no closures. Any allocation in the audio hot path
  causes GC pauses and audio glitches. Pre-allocate all buffers and state as class fields.

## Template

// @param gain 1.0

class Processor {
    gain = 1.0
    paramChanged(label, value) {
        if (label === "gain") this.gain = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            outL[i] = srcL[i] * this.gain
            outR[i] = srcR[i] * this.gain
        }
    }
}
```
