# openDrum Kick

A synthesized kick drum. It reaches deep booming kicks, short punchy club kicks, hard distorted kicks and kicks
with a rumbling tail, all without samples.

---

## 0. Overview

_openDrum Kick_ plays one hit per note. The display shows the hit the current values make, with its level and its
pitch over time.

1. On a track, the key sets the pitch: key 60 plays at Tune, every key above or below moves it by a semitone.
2. In a Playfield pad, every hit plays at Tune.
3. Every value can be automated.

Example uses:

1. A long falling 808 style boom for hip hop and trap
2. A short click heavy kick for techno and house
3. A rumble kick for hard techno: the tail ducks under every hit
4. A kick bass line with Gate and Glide

---

## 1. Body

The tone of the drum.

1. **Tune**: the pitch the body settles on, 30 to 120 Hz.
2. **Pitch**: how far above Tune the hit starts, up to 48 semitones.
3. **Sweep**: how long the fall from Pitch to Tune takes.
4. **Drift**: a second, slow fall during the decay that sinks the pitch further.
5. **Decay**: how long the body rings.
6. **Punch**: the shape of the decay. Negative drops fast and lingers, positive holds the level and ends sooner.
7. **Shape**: the wave of the body, from a pure sine to a harder wave with more overtones.
8. **Skin**: the overtones of a drum skin that ring shortly after the hit.

---

## 2. Strike

The attack of the hit.

1. **Click**: the level of the click at the start.
2. **Tone**: the brightness of the click, 200 Hz to 16 kHz.
3. **Noise**: the click from a sharp tick to a short burst of noise.
4. **Drive**: saturation, up to 36 dB. It adds weight and grit, the level stays close to the clean hit.

---

## 3. Rumble

A dark tail made from the kick itself, for rumble kicks.

1. **Level**: how loud the rumble is. At 0 there is no rumble.
2. **Length**: when the rumble has faded, from 1/16 to a whole bar of the song's tempo.
3. **Duck**: how strongly the kick pushes the rumble down while it is loud, so both sound like one hit.
4. **Bright**: the rumble from a dark sub to open and gritty.

---

## 4. Play

1. **Volume**: the level of the device.
2. **Velocity**: how much the note's velocity changes the level and how far the pitch falls.
3. **Mode**:
    1. **Mono**: a new note cuts the ringing one.
    2. **Poly**: hits ring on and overlap.
    3. **Gate**: as Mono, and the hit is cut short when its note ends.
4. **Glide**: in Mono and Gate, a new note slides from the sounding pitch.
