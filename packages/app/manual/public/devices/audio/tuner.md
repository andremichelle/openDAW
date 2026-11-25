# Tuner

Tuner measures the pitch of one note at a time without changing the audio. Insert it in an audio-effect chain on an instrument or monitored audio track. For a microphone or guitar input, enable the track's input monitoring.

## Controls

The row above the display holds four controls, each with its label above it.

- **View**: **Meter** shows how far the note is from the nearest note. **History** shows the pitch of the last eight seconds.
- **Display** (in Meter): **Needle** points a triangle at the deviation, flat to the left and sharp to the right, from −50 to +50 cents. **Strobe** moves stripes to the right when sharp and to the left when flat, and they stand still when the note is in tune.
- **Range** (in History): **Follow** keeps the played note in the middle. **Fixed** keeps the current note range. Drag the display vertically to pan and horizontally to zoom, which also switches to Fixed in one undo step. Escape cancels a drag. Double-click the display to follow again.
- **Readout**: shows the deviation in **Cents** or the frequency in **Hz** below the display.
- **Reference**: the tuning frequency of A3 (MIDI 69), from 410 to 480 Hz, 440 Hz by default. Drag the value or double-click it to type. openDAW names this note A3, matching its piano roll, scientific pitch notation calls it A4.

## Display

Green means the note is within 5 cents of the target, orange means it is out of tune. After the signal stops, the last reading holds for 120 ms, then fades over one second and stays dimmed below the display until the next note. In History, the key of the detected note lights up on the right, silence leaves gaps in the trace, and the note names thin out to white keys or only C when the range is zoomed out. Bypass clears the display.

## Detection

The detector covers about 30 to 2000 Hz and updates 30 times per second. It analyses the louder stereo channel and ignores audio below −55 dBFS. Low notes need several periods of audio before a reading appears. Play clean, sustained, single notes, chords and noise give ambiguous readings. Tuner measures, it does not correct pitch.

Settings are saved with the project. The history is not saved.
