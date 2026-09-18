# Nano

A minimal sample playback instrument. Load a single sample and play it chromatically across the keyboard.

---

![screenshot](nano.webp)

---

## 0. Overview

_Nano_ turns one audio file into a playable instrument. Every note reads the sample at a rate relative to the root key, so a single sample covers the whole keyboard. A start/end region, a crossfaded loop and an attack/release envelope shape how it plays.

Example uses:

- Quick chromatic sampling of any sound
- Sustained pads from a short sample using the crossfade loop
- Reversed hits and swells
- Placeholder instruments during composition

---

## 1. Waveform

The display shows the loaded sample. The bright part is the region that plays, the dimmed parts are skipped.

- **Drag & drop**: Drop an audio file or a sample from the browser onto the display
- **Click**: Browse for a sample while the display is empty
- **Drag a marker**: Move the region start or end, or a loop point, directly on the waveform. Region markers take precedence when both are close.
- **Right-click**: Context menu for sample options
- Blue lines show the read position of every playing voice
- With the loop on, green lines mark the loop points and the shaded areas show where the crossfade happens

---

## 2. Main

### 2.1 Root

The note that plays the sample at its original pitch. Every other note transposes relative to it.

### 2.2 Gain

Output level in dB.

---

## 3. Pitch

### 3.1 Tune

Fine tuning in cents, up to an octave in either direction. 100 cents equal one semitone.

### 3.2 Octave

Shifts the whole keyboard up or down by octaves.

---

## 4. Envelope

### 4.1 Attack

Fade-in time after note-on.

### 4.2 Release

Fade-out time after note-off. Longer values let the sample ring out; shorter values cut it quickly. Changes reach notes that are already playing.

---

## 5. Waveform

### 5.1 Start / End

The part of the sample that plays, as a percentage of its length. Set the start past the end to play the sample backwards. The device menu offers _Reverse_, which swaps the two values.

---

## 6. Loop

### 6.1 Start / End

The loop range, as a percentage of the sample length. The loop points stay inside the region.

### 6.2 Fade

The crossfade length at the loop point. Longer fades hide the seam on sustained material, shorter fades keep transients sharp.

### 6.3 On

While on, a held note cycles the loop range instead of stopping at the end of the region. The release still ends the note.

---

## Credits

Root key, octave, sample region, crossfade loop and the attack envelope were contributed by [SynthsBack-lab](https://github.com/SynthsBack-lab).
