# Tuner

Tuner measures the pitch of one note at a time without changing the audio. Insert it in an audio-effect chain on an instrument or monitored audio track. For a microphone or guitar input, enable the track's input monitoring.

## Display

- **Target**: a straight meter spans −50 to +50 cents around the closest equal-tempered note. Flat is left; sharp is right. A downward triangle points to the current deviation, with a fixed center mark at zero; green indicates a deviation within ±5 cents and orange indicates an out-of-tune note. The note and signed deviation are displayed below the scale. After signal loss the last reading holds for 120ms, then gently fades over 1000ms. A new note is acquired immediately; bypass clears the reading immediately.
- **Strobe**: segments move right for sharp and left for flat above the straight scale. Motion slows as the note approaches the target.
- **Histogram**: an eight-second pitch trace against note-center lines, with labeled note-key bands on the right-hand Y axis. The detected note's key is highlighted green; the highlight follows the reading's hold/fade behavior. Silence and unreliable detections leave gaps. Drag vertically to pan and horizontally to zoom, with live feedback. Releasing the pointer saves the range and selects Manual in one undo step; Escape cancels the gesture without saving. Double-click to resume automatic following.
- Four equal-width controls at the top select **Meter**, **Hist** (Histogram), **ct/Hz**, and the contextual mode. In Meter, the mode switches **Target/Strobe**. In Histogram, it switches **Auto/Manual**: Auto follows incoming pitch; Manual freezes the currently visible range. View selection does not change the stored meter mode.
- **ct/Hz** switches the main readout between tuning deviation and absolute frequency.

## Parameters

- **Reference**: drag the tuning-frequency value in the bottom bar, or double-click to type it, just like Revamp's values. Range 410–480 Hz; default 440 Hz. openDAW labels this reference A3 (MIDI 69), matching its piano roll; scientific pitch notation calls it A4. This is only a naming convention.

The detector covers approximately 30–2000 Hz and updates at 30 Hz. It defaults to analyzing the stronger stereo channel, ignoring audio below −55 dBFS, and smoothing the display. Low notes need several periods of audio before a reading appears. Play clean, sustained, monophonic notes; chords, noise, and strong harmonics can produce ambiguous pitches. The detector is a measurement aid, not pitch correction.

Settings are saved with the project. History is a live display and is not saved. Tuner currently requires the default WASM engine.
