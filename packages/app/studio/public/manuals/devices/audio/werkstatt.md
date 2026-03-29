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

The toolbar at the top provides:

- **Compile** — Compile and load the code into the audio engine
- **Examples** — Load ready-made processors to learn from
- **From Clipboard** — Paste code from the clipboard into the editor and compile it in one step
- **Start AI-Prompt** — Copy a device-specific AI starter prompt to the clipboard, ready to paste into an AI assistant (e.g. ChatGPT, Claude) for help writing processors
- **Close Editor** — Return to the previous view

The status bar at the bottom shows the current state:

- **Idle** — No compilation attempted yet
- **Successfully compiled** — Code compiled and loaded into the audio engine
- **Error message** — Syntax error or runtime error details

---

## 2. Label

Set the device name using a `// @label` comment:

```javascript
// @label My Effect
```

When the script compiles, the device panel header will display this name. Omitting `@label` keeps the current name. An empty `@label` (without a name) causes a compile error.

---

## 3. Parameters

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

### Groups

Organize parameters visually using `// @group` comments:

```javascript
// @group Envelope green
// @param attack  0.01  0.001  1.0  exp  s
// @param decay   0.2   0      2.0  exp  s
// @param sustain 0.7
// @param release 0.5   0      5.0  exp  s
// @group Filter blue
// @param cutoff  1000  20  20000  exp  Hz
// @param resonance 0.5
```

```
// @group <name> [color]
```

Parameters and samples declared after a `@group` belong to that group until the next `@group` or end of declarations. Each group renders as a labeled section on the device panel with a colored header.

Available colors: `blue`, `green`, `yellow`, `cream`, `orange`, `red`, `purple`, `white`, `gray`, `dark` (default).

Parameters before any `@group` appear ungrouped.

---

## 4. Keyboard Shortcuts

| Shortcut            | Action                              |
|---------------------|-------------------------------------|
| `Alt+Enter`         | Compile and run                     |
| `Ctrl+S` / `Cmd+S` | Compile, run, and save to project   |

---

## 5. Safety

The engine validates your output on every audio block:

- **NaN detection** — If any output sample is NaN, the processor is silenced and the error is reported.
- **Overflow protection** — If any sample exceeds ~60 dB (amplitude > 1000), the processor is silenced.
- **Runtime errors** — If `process()` throws an exception, the processor is silenced and the error is shown.

When silenced, the device outputs silence until the next successful compile.

---

## 6. API Reference

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

## 7. Examples

Select **Examples** in the code editor toolbar to load ready-made processors (Hard Clipper, Ring Modulator, Simple Delay, Biquad Lowpass).

---

## 8. AI Assistance

Click **Start AI-Prompt** in the editor toolbar to copy a detailed starter prompt to your clipboard. Paste it into any AI assistant to get help writing Werkstatt processors. Once the AI generates code, copy it and click **From Clipboard** to load and compile it directly.
