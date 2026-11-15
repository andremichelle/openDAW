# Filter

A MIDI effect that passes a range of keys and transposes them or sets them to one key.

---

## 0. Overview

_Filter_ lets only the notes between **Min** and **Max** through. The passing notes are then either transposed by a number of semitones or all played as one key.

Example uses:

- Keyboard splits, one Filter per layer
- Pulling a single drum out of a drum loop
- Playing a range of keys as one key, for example to trigger a one-shot sample

---

## 1. Filter

- **Min**: The lowest key that passes, included.
- **Max**: The highest key that passes, included.

Both range from **C-2 to G8**. If Min is above Max, no note passes.

---

## 2. Transpose

- **Set**: Switches between adding semitones and setting a key.
- **Semitones** (Set off): Added to every passing note. Range: **-127 to +127**. A note that lands outside C-2 to G8 is ignored.
- **Key** (Set on): Every passing note plays as this key.

---

## 3. Technical Notes

- All parameters are automatable
- Velocity and fine pitch are preserved
- A note ends on the key it started with, even if the parameters change while it sounds
