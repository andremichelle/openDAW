# Tubular

A six-operator FM synthesizer compatible with the Yamaha DX7. The engine is a port of Dexed's msfa core, so
DX7 cartridges sound the way they do in Dexed and on the hardware.

---

## 0. Overview

Six sine operators are wired by one of 32 algorithms. Operators feeding another operator are modulators,
operators feeding the output are carriers. Every operator has its own four-stage envelope, keyboard level
and rate scaling, velocity sensitivity and frequency (a ratio of the note or a fixed frequency). One LFO
modulates pitch and amplitude, a pitch envelope bends every operator, and a low-pass filter with resonance
sits on the output.

## 1. Cartridges

The cartridge button opens the bundled banks (32 voices each) and any `.syx` you loaded. Picking a voice writes
it into the device, so a project never depends on the cartridge afterwards. The arrows step through the voices
of the current bank.

Bundled banks and their credits:

- Dexed 01 and SynprezFM 01 to 32, the cartridges shipped with Dexed, DX7 programs compiled by Jean-Marc
  Desprez (SynprezFM), GPL-3.0.
- YM2612 ROM 1 to 4 by Nick Culbertson, Sega Genesis style instruments, MIT.

## 2. Loading your own voices

The device menu and the cartridge menu offer _Load DX7 .syx…_ for a 32-voice bulk dump (4104 or 4096 bytes),
a single voice dump (163 bytes) or a stream of dumps. The Yamaha factory ROMs and the many community banks
found online load this way.

## 3. Parameters

All 156 voice and output parameters are automatable. The values are the hardware's own: rates and levels 0 to
99, algorithm 1 to 32, feedback 0 to 7, detune -7 to +7, transpose around C3.

## Credits

Engine: Google's music-synthesizer-for-android (Apache-2.0) as maintained in Dexed by Pascal Gauthier, with
Dexed's voice handling and output filter (GPL-3.0). Tubular is not affiliated with Yamaha or Dexed.
