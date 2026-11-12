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

## Soundfont import

The soundfont is processed once and then dropped from memory. It is not stored. Its samples become ordinary local
samples in the OPFS.

1. One preset at a time. The dialog lists the presets of the file and the user picks one.
2. Only the samples that preset uses are extracted. Left and right linked samples become one stereo file. Each
   sample keeps its soundfont name.
3. The samples go to `Multi Samples/<Soundfont name>/` in the Local tab of the sample browser, mirroring the cloud
   folder. One folder per soundfont, not per preset, because presets of one soundfont share samples.
4. A sample is never stored twice. Importing another preset of the same soundfont reuses what is already there.
5. The preset becomes the sample zones of one Sampler: ranges, root key, tuning, loop points, pan, attenuation.
6. SFZ and folder imports use the same path: `Multi Samples/<Instrument name>/`.
7. Eventually the import dialog needs a preview, to hear a preset before importing it.

## Loading

A preset can reference a hundred samples and more. That is heavy on the network and on the OPFS, and the OPFS is
known to hang sometimes when projects load. Decided 2026-11-12: no guesswork upfront. The Sampler loads its samples
the way every device does. Retries, timeouts and load order are revisited when real issues show up.

## Boxes (done, uncommitted)

1. `SamplerDeviceBox`: hubs `zones` (10), `groups` (11), `modulations` (12). Parameters: voices, glide, legato,
   octave, transpose, tune (20 to 25), filter-type, cutoff, resonance (30 to 32), volume, panning, mono (40 to 42),
   objects amp-envelope (50) and mod-envelope (51) with delay, attack, hold, decay, sustain, release, objects lfo-a
   (60) and lfo-b (61) with shape, rate, delay, fade, sync, restart. All automatable.
2. `SamplerZoneBox`: pointers device, file, group, then key range, velocity range, fades, root key, transpose,
   tune, key-track, gain, panning, sequence, reverse, one-shot, sample-start, sample-end, loop-mode, loop-start,
   loop-end, loop-fade. Plain fields, not automatable.
3. `SamplerGroupBox`: pointer device, hub zones, label, round-robin, choke, trigger.
4. `SamplerModulationBox`: pointer device, source, target, amount.
5. Sample positions (start, end, loop start, loop end) are frames, not fractions, so imported loops stay exact.
6. Bend is not in the schema. openDAW has no pitch bend yet, add it with Mod Wheel and Aftertouch. Play has Octave
   in its place.
7. A full modulation amount reaches 48 semitones for Pitch, 4 octaves for the LFO rates, the full range elsewhere.

Adapters: `SamplerDeviceBoxAdapter`, `SamplerZoneBoxAdapter`, `SamplerGroupBoxAdapter`,
`SamplerModulationBoxAdapter`, `SamplerModulation` (sources and targets). The device is not in
`InstrumentFactories` yet, so it does not show up in the studio before the engine can play it.

## Engine (done, uncommitted)

1. `abi::observe_table(hub_path, columns)`: a device observes the child boxes under one of its hubs as rows of
   32-bit words and gets each snapshot through `table_changed`. A column is a child's own field (int, float bits
   or bool), a pointer to an audio file (delivered as the sample handle, loaded like any observed sample) or a
   pointer to another box (delivered as an int field of that box). Nothing on the host names a box or a field.
2. The engine side is `crates/engine/src/table.rs`. A change only raises a flag, the unit reconcile delivers one
   snapshot per changed table. The words stay in engine memory until the next snapshot, so the device reads them
   during render without a copy and without a limit on the number of zones.
3. `crates/stock-devices/device-sampler`: zones, round robins (cycle, random), key and velocity crossfades,
   release groups, choke, voice limit, legato and glide, cubic interpolation, loop with crossfade, two DAHDSR
   envelopes, two LFOs with delay, fade, tempo sync and restart, a 12 or 24 dB filter, modulation slots. A voice
   copies its zone when it starts, so a zone edit reaches the next note and never a sounding one.
4. Tests: 11 for the abi table type, 37 for the engine binding, 124 for the device, 6 end to end through the wasm
   engine (`packages/studio/core-wasm/test/sampler.test.ts`), plus the parameter mapping parity of all 36
   parameters.

## Editor (done, uncommitted)

1. `InstrumentFactories.Sampler` creates the device with one group and one modulation slot (Velocity to Gain at
   80%).
2. Device panel `SamplerDeviceEditor`: Play, Filter, Mix, tabbed Envelope and LFO groups with real automatable
   parameters, the modulation list, Edit Sample Zones in the header.
3. Sample zone window: a `FloatingWindow` like the plugin windows, one per device. Map, piano, groups, sample
   zones, modulation list, waveform, zone fields, every panel parameter.
4. `SamplerZones` in the adapters holds the tools (map by name, spread keys, spread velocity, crossfade, root to
   low, duplicate, move to group, disable, clean up) with 29 tests.
5. A sample file box cannot exist without a zone pointing at it. So Delete switches a zone off (`enabled`), it
   stays in the list dimmed, Restore switches it on again and Clean Up removes the zones that are off, with their
   samples.
6. File name notes are scientific pitch: `C4` is key 60, as sample libraries write them. openDAW shows that key as
   C3.
7. Manual page `devices/instruments/sampler.md`.

## Next

1. SFZ and SF2 import, and the Import button in the window.
2. Scripting API.
3. Release notes with the DEV deploy.
4. A synced LFO still prints its rate in Hz. Groups cannot be renamed or deleted yet.

## Open

1. The design is signed off (2026-11-12). The user interface calls the zones "Sample Zones".
2. A zone edit delivers the whole zone table again. Fine for hundreds of zones, to be measured for thousands.
