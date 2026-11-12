# Sampler (instrument)

A multi-zone sampler for issue #538. It maps many samples by key and velocity, with round robins and groups, and is
meant to replace the Soundfont player in the long run.

## Goal

1. Play sample libraries recorded per note and per dynamic (VCSL, SFZ libraries, soundfonts).
2. Edit the mapping in a large window, play and automate the instrument from the device panel.
3. Import SFZ and SF2, and map a folder of samples from its file names.
4. Samples load on demand from the catalogue, the way projects reference them.

## State

UI preview only, on `/testing` (`ui/pages/testing/SamplerPreview.tsx`, helpers in `ui/pages/testing/sampler/`). Mock
data and drawn waveforms. No box, adapter or engine yet. The layout rules that came out of it are in `/DESIGN.md`.

## Device panel

568px wide, no preview of the zone ranges.

1. **Play**: Voices, Glide, Legato, Transp, Tune, Bend.
2. **Filter**: Type, Cutoff, Reso.
3. **Mix**: Volume, Pan, Mono (0% by default).
4. **Envelope** with tabs Amp Envelope and Mod Envelope: Delay, Attack, Hold, Decay, Sustain, Release.
5. **LFO** with tabs LFO 1 and LFO 2: Shape, Rate, Delay, Fade, Sync, Restart. LFOs run per voice and restart on
   every note unless Restart is off.
6. **Modulation**: a list of slots (source, target, amount) the user adds and removes.
7. Edit Zones in the header opens the window.

## Modulation

1. Sources: Amp Env, Mod Env, LFO 1, LFO 2, Velocity, Key, Random.
2. Targets: Pitch, Cutoff, Reso, Gain, Pan, Start, Loop, LFO 1 Rate, LFO 2 Rate, Env Depth.
3. Env Depth scales the amounts of the Mod Env slots.
4. Velocity to Gain is a default slot (80%), there is no fixed velocity sensitivity.
5. No fixed number of slots in the design. A limit, if the engine needs one, is André's call.

## Zone window

1. Preset name and sample count ("90 samples, 2 unused") at the top left. Clean Up, Add Samples and Import SFZ / SF2
   at the top right. Clean Up removes every sample no zone uses from the instrument. The files stay in storage.
2. Tools for the selection, each with a tooltip:
   1. Select All: every zone of the shown group.
   2. Map by Name: reads note (C4, c#3) and dynamic (pp to fff, later v1, rr1) from the file names, sets root, keys
      and velocity layers.
   3. Spread Keys: each zone reaches halfway to the neighbouring roots, no key stays empty.
   4. Spread Velocity: the layers on the same keys share the velocity range evenly.
   5. Crossfade: neighbours overlap and fade into each other, over keys and velocities.
   6. Root to Low: the root key becomes the lowest key of the zone.
   7. Duplicate: copies the zones onto the same keys as further round robins.
   8. Move to Group.
   9. Delete: removes the zones, their samples stay until Clean Up.
3. Key × velocity map with the piano below it over the full width. Zones are dragged and resized there, a selection
   rectangle selects many.
4. Groups list, Zones list, Modulation list.
5. Waveform of the focused zone.
6. Zone groups: **Group** (Robin, Choke, Trigger), **Key** (Low, High, Fade), **Velocity** (Low, High, Fade),
   **Pitch** (Root, Transp, Tune), **Play** (Gain, Pan, Track, Seq, Reverse, One Shot), **Sample** (Start, End, Loop,
   Fade, From, To).
7. Every parameter of the device panel, with the same state.

## Zones and groups

1. A zone holds one sample with key range, velocity range, root key, crossfades, tuning, key tracking, gain, pan,
   start and end, reverse, one shot and its loop.
2. Loop modes: Off, On (loops while the key is held and plays out on release), Always (keeps looping through the
   release).
3. Zones on the same keys and velocities in one group are round robins, Seq is their position.
4. A fade applies only at an edge where another zone of the same group overlaps. Outer edges never fade. The map
   draws the fades.
5. A group sets the round robin mode (Off, Cycle, Random), a choke group and the trigger (Attack or Release).

## Soundfont coverage

The current Soundfont player reads key and velocity range, root key, loop on or off, pan and the volume ADSR. The
Sampler covers those plus tuning, key tracking, attenuation, sample offsets, sustain loop, exclusive class, full
envelopes, lowpass filter, two LFOs and velocity routing. One Sampler is one preset of a soundfont, chosen at import.

Not covered, decided:

1. Envelopes and filter per zone. Rarely used outside GM drum kits, dropped.

## Later, when openDAW supports it

1. Mod Wheel and Aftertouch as modulation sources. SF2 routes both to vibrato by default. openDAW has neither yet,
   add them to the source list once it does.

## Samples in the cloud

The catalogue is the folder tree in `assets.opendaw.studio/samples/index.json`. Its folders under `openDAW` are
`Loops`, `One Shots` and `Impulse Responses`: title case, words separated by a space.

1. The samples of an instrument get their own folder next to those: `Multi Samples`, written like its siblings.
2. Below it one sub-folder per instrument (`Multi Samples/Upright Piano`). The samples appear there in the sample
   browser as single files, like any other sample.
3. A preset references its samples from the catalogue, the way projects do.

## Loading

A preset can reference a hundred samples and more. That is heavy on the network and on the OPFS, and the OPFS is
known to hang sometimes when projects load. Decided 2026-11-12: no guesswork upfront. The Sampler loads its samples
the way every device does. Retries, timeouts and load order are revisited when real issues show up.

## Open

1. The design is signed off (2026-11-12). The user interface calls the zones "Sample Zones".
2. Box schema for zones, groups and slots, adapter, engine crate, SFZ and SF2 import, mapping from file names: not
   planned yet.
