---
title: Shadertoy Visualizer
category: Studio Manual
tags:
  - manual
  - Studio Manual
  - shadertoy
desc: Documentation
---
# Shadertoy Visualizer

Create real-time visuals for your music using GLSL shaders. The editor supports Shadertoy-compatible syntax, so you can learn from their community and adapt techniques to your own creations.

[Shadertoy](https://shadertoy.com)

---

## 0. Overview

The Shadertoy panel lets you write fragment shaders that respond to audio and MIDI data from your project. Audio spectrum and waveform data arrive via `iChannel0`, and MIDI data is available through helper functions.

---

## 1. MIDI Setup

To send MIDI to the visualizer, add a **MIDI Output** device to any track and select **Shadertoy** as the destination. This routes note and controller data to the shader. You can use clips, live input, or automation to drive your visuals.

---

## 2. Supported Uniforms

| Uniform | Type | Description                                            |
|---------|------|--------------------------------------------------------|
| `iResolution` | `vec3` | Viewport size (width, height, 1.0)                     |
| `iTime` | `float` | Elapsed time in seconds                                |
| `iTimeDelta` | `float` | Time since last frame                                  |
| `iFrame` | `int` | Frame counter                                          |
| `iBeat` | `float` | Beat position (quarter notes)                          |
| `iPeaks` | `vec4` | Stereo levels (leftPeak, rightPeak, leftRMS, rightRMS) |
| `iChannel0` | `sampler2D` | Audio texture (512×2)                                  |
| `iChannelResolution` | `vec3[1]` | Audio texture size (512, 2, 1)                         |

---

## 3. Audio Data

Audio data is stored in `iChannel0` as a 512×2 texture:

```glsl
// Spectrum (row 0) - logarithmic 20Hz to 18kHz
float spectrum = texture(iChannel0, vec2(uv.x, 0.25)).r;

// Waveform (row 1) - signed audio, map to -1..1
float wave = texture(iChannel0, vec2(uv.x, 0.75)).r * 2.0 - 1.0;
```

---

## 4. MIDI Functions

```glsl
// Returns velocity (0.0-1.0) if note is on, 0.0 if off
// Pitch: 60 = C4 (Middle C)
float midiNote(int pitch);

// Returns CC value (0.0-1.0)
float midiCC(int cc);
```

**Example:**
```glsl
float kick = midiNote(60);      // C3
float value = midiCC(64);
```

---

## 5. Not Supported

The following Shadertoy features are **not available**:

- `iMouse` — Mouse input
- `iDate` — Date/time
- `iSampleRate` — Sample rate
- `iChannelTime` — Channel playback time
- `iChannel1..3` — Additional texture channels
- **Multi-pass buffers** (Buffer A/B/C/D)
- **Cubemap / 3D textures**

---

## 6. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Enter` | Compile and run |
| `Ctrl+S` / `Cmd+S` | Save to project |

---

## 7. Example

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    
    // Spectrum glow
    float spectrum = texture(iChannel0, vec2(uv.x, 0.25)).r;
    vec3 col = vec3(0.2, 0.5, 1.0) * spectrum;
    
    // Pulse on beat
    float pulse = exp(-fract(iBeat) * 4.0);
    col += pulse * 0.2;
    
    // React to MIDI note
    float vel = midiNote(60);
    col = mix(col, vec3(1.0, 0.3, 0.5), vel);
    
    fragColor = vec4(col, 1.0);
}
```