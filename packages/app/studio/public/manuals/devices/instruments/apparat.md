# Apparat

A programmable instrument that lets you write custom synthesizers and samplers in JavaScript. Generate audio from note events, load samples for granular synthesis, declare parameters with knobs, and hot-reload changes in real time.

---

![screenshot](apparat.webp)

---

## 0. Overview

_Apparat_ is a scriptable instrument device. You write a `Processor` class in JavaScript that receives note events and generates stereo audio. Parameters and samples declared in the code appear as automatable knobs and file pickers on the device panel.

Example uses:

- Custom synthesizers (additive, subtractive, FM, wavetable)
- Sample playback with pitch tracking
- Granular synthesis
- Algorithmic sound generators
- Prototyping new instrument ideas

---

## 1. Editor

Click the **Editor** button on the device panel to open the full-screen code editor. The editor uses Monaco (the engine behind VS Code) with JavaScript syntax highlighting.

The toolbar at the top provides:

- **Compile** — Compile and load the code into the audio engine
- **Examples** — Load ready-made instruments to learn from
- **From Clipboard** — Paste code from the clipboard into the editor and compile it in one step
- **Start AI-Prompt** — Copy a device-specific AI starter prompt to the clipboard, ready to paste into an AI assistant (e.g. ChatGPT, Claude) for help writing instruments
- **Close Editor** — Return to the previous view

The status bar at the bottom shows the current state:

- **Idle** — No compilation attempted yet
- **Successfully compiled** — Code compiled and loaded into the audio engine
- **Error message** — Syntax error, runtime error, or validation failure

---

## 2. Label

Set the device name using a `// @label` comment:

```javascript
// @label My Synth
```

When the script compiles, the device panel header will display this name. Omitting `@label` keeps the current name. An empty `@label` (without a name) causes a compile error.

---

## 3. Parameters

Declare parameters using `// @param` comments at the top of your code:

```javascript
// @param attack  0.01  0.001  1.0  exp  s
// @param release 0.3   0.01   2.0  exp  s
// @param mode    0     0      3    int
// @param bypass  false
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

### Mapped

```
// @param attack 0.01 0.001 1.0 exp s   → exponential 0.001–1.0, default 0.01
// @param mode 0 0 3 int                → integer 0–3, default 0
```

The knob displays the mapped value with the unit. `paramChanged` receives the mapped value directly.

### Boolean

```
// @param bypass false         → Off/On, default Off
// @param bypass true          → Off/On, default On
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

## 4. Samples

Declare samples using `// @sample` comments:

```javascript
// @sample wavetable
// @sample grain
```

Each `@sample` creates a file picker on the device panel. Drag an audio file onto it or click to browse. The sample data is available in the processor as `this.samples.<name>`.

When loaded, `this.samples.wavetable` returns an `AudioData` object:

```javascript
{
    sampleRate: number,                       // original sample rate
    numberOfFrames: number,                   // number of frames
    numberOfChannels: number,                 // 1 (mono) or 2 (stereo)
    frames: [Float32Array, Float32Array]      // per-channel sample data
}
```

Returns `null` before the sample is loaded. Always check:

```javascript
const data = this.samples.grain
if (data === null) return
```

When playing back samples, account for sample rate differences between the sample and the project:

```javascript
const playbackRate = data.sampleRate / sampleRate
```

---

## 5. Keyboard Shortcuts

| Shortcut            | Action                              |
|---------------------|-------------------------------------|
| `Alt+Enter`         | Compile and run                     |
| `Ctrl+S` / `Cmd+S` | Compile, run, and save to project   |

---

## 6. Safety

The engine validates your output on every audio block:

- **NaN detection** — If any output sample is NaN, the processor is silenced and the error is reported.
- **Overflow protection** — If any sample exceeds ~60 dB (amplitude > 1000), the processor is silenced.
- **Runtime errors** — If `process()` throws an exception, the processor is silenced and the error is shown.

When silenced, the device outputs silence until the next successful compile.

---

## 7. API Reference

Your code must define a `class Processor` with a `process` method. Optionally implement `noteOn`, `noteOff`, `reset`, and `paramChanged`.

### Globals

| Variable     | Type     | Description                              |
|--------------|----------|------------------------------------------|
| `sampleRate` | `number` | Audio sample rate in Hz (e.g. 48000)     |

### Processor class

```javascript
class Processor {
    noteOn(pitch, velocity, cent, id) { }   // note starts (sample-accurate)
    noteOff(id) { }                          // note ends (sample-accurate)
    reset() { }                              // transport stop — fast-release all voices
    paramChanged(label, value) { }           // parameter knob changed
    process(output, block) { }               // generate audio
}
```

### Note methods

`noteOn` and `noteOff` are called at the exact sample position within the block. The host splits the block at event boundaries and calls `process()` between them:

```
[host clears output buffer]
process(output, {s0: 0, s1: 47, ...})     // existing voices render
noteOn(60, 0.8, 0, 42)                     // note starts at sample 47
process(output, {s0: 47, s1: 128, ...})    // new voice renders
```

| Parameter  | Type     | Description                                |
|------------|----------|--------------------------------------------|
| `pitch`    | `number` | MIDI note number (0–127)                   |
| `velocity` | `number` | Note velocity (0.0–1.0)                    |
| `cent`     | `number` | Fine pitch offset in cents                 |
| `id`       | `number` | Unique note identifier (use for noteOff)   |

Always use `id` to identify notes — not pitch. Multiple notes on the same pitch can be active simultaneously.

### reset()

Called on transport stop and position jumps. Put all voices into a fast release (e.g., 5ms fade) to avoid clicks. Do NOT hard-kill voices with `this.voices = []`.

### process(output, block)

The host clears the output buffer before each block. You write to it with `=` or `+=`.

- `output[0]` — left channel (`Float32Array`)
- `output[1]` — right channel (`Float32Array`)

### Block properties

| Property | Type     | Description                                           |
|----------|----------|-------------------------------------------------------|
| `s0`     | `number` | First sample index to process (inclusive)              |
| `s1`     | `number` | Last sample index to process (exclusive)               |
| `index`  | `number` | Block counter                                          |
| `bpm`    | `number` | Current project tempo                                  |
| `p0`     | `number` | Start position in ppqn                                 |
| `p1`     | `number` | End position in ppqn                                   |
| `flags`  | `number` | Bitmask: 1=transporting, 2=discontinuous, 4=playing, 8=bpmChanged |

---

## 8. Examples

Select **Examples** in the code editor toolbar to load ready-made instruments (Simple Sine Synth, Grain Synthesizer).

---

## 9. AI Assistance

Click **Start AI-Prompt** in the editor toolbar to copy a detailed starter prompt to your clipboard. Paste it into any AI assistant to get help writing Apparat instruments. Once the AI generates code, copy it and click **From Clipboard** to load and compile it directly.
