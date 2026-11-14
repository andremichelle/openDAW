# openDrum Cymbal

Cymbals from six square oscillators in three bands: a body that swells in and rings longest, a bright top that fades
sooner and a sizzle above. Every hit starts the oscillators somewhere else.

---

## 0. Overview

_openDrum Cymbal_ plays one hit per note. The display shows the hit the current values make, with its level over time.

1. On a track, key 60 plays at Tune, every key above or below moves it by a semitone.
2. In a Playfield pad, every hit plays at Tune.
3. Every value can be automated.

Example uses:

1. A classic drum machine cymbal
2. A long crash with Decay at several seconds
3. A reversed swell into a downbeat with Attack

---

## 1. Shape

1. **Tune**: the pitch of all six oscillators, as a factor of the classic tuning.
2. **Tone**: raises the sizzle through the whole hit and turns the body down, from dark to bright.
3. **Attack**: how long all bands take to fade in.
4. **Decay**: how long the cymbal rings.

---

## 2. Play

1. **Volume**: the level of the device.
2. **Velocity**: how much the note's velocity changes the level.
3. **Mode**:
    1. **Mono**: a new note cuts the ringing one.
    2. **Poly**: hits ring on and overlap.
    3. **Gate**: as Mono, and the hit is cut short when its note ends.
