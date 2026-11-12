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
4. Velocity to Gain is a default slot (100%), there is no fixed velocity sensitivity.
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
   100%).
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

## Import (done, uncommitted)

1. Import SFZ / SF2 in the window opens one file dialog. A `.sf2` asks for the preset, an `.sfz` is chosen
   together with the samples it names.
2. The importer is loaded when the button is used (`import("./SamplerImporter")`), the soundfont reader through
   `ExternalLib.SoundFont2`. Nothing of it is in the boot bundle.
3. `SamplerImport` in the adapters describes an instrument before it becomes boxes and applies it: it replaces
   the zones and groups of the device, names it, and sets the amp envelope and the filter.
4. `SamplerSoundfont` converts one preset: ranges, root key, tuning, key tracking, attenuation, pan, sample and
   loop offsets, loop mode, exclusive class as choke groups. Preset generators add to the instrument's. A linked
   left and right sample on the same keys become one stereo sample. Each sample is stored once.
5. `SamplerSfz` reads headers, inherited opcodes, `#define`, `default_path`, keys as names or numbers, velocity,
   tuning, volume, pan, offsets, loop modes, round robins (`seq_*`, `lorand`), `group` with `off_by` as choke,
   `trigger=release`, `direction=reverse`, the amp envelope and the filter.
6. Samples are stored as local samples (found again by their content, never stored twice) and filed under
   `Multi Samples/<file name>` with `ResourceStructures.place`.
7. Tests: 32 for import, soundfont and SFZ, 6 for the folder placement. The converter was also run on the stock
   Concert Harp soundfont (36 zones, 36 samples).

## Export (done, uncommitted)

1. Export SF2 in the window saves the Sampler as a soundfont with one preset. The exporter is loaded when the
   button is used (`import("./SamplerExporter")`).
2. `SamplerSoundfontExport` in the adapters: `describe` turns the device into the same description the import
   uses, `encode` writes the file, `quantize` turns floats into 16 bit and counts what would clip. No library,
   the writer is ours.
3. Written: ranges, root key, tuning, key tracking, attenuation, pan, sample and loop offsets, loop mode, choke
   as exclusive class, the amp envelope and a lowpass filter on every zone. A stereo sample becomes a linked left
   and right pair. Zones that share a sample share its frames. A reversed zone gets a reversed copy of its
   sample with mirrored points, so it sounds as it does in the Sampler.
4. Left out: further round robins (the first of each is kept), release trigger groups, fades, One Shot,
   the mod envelope, LFOs and modulation slots. The dialog names what is left out and asks before it clips.
5. Tests: 20, most of them write a soundfont and read it back through the soundfont reader and the importer.
   Not tried in the browser and not opened in another soundfont player yet.

## Samples from the browser (done, uncommitted)

1. A sample dragged from the sample browser, or audio files from the desktop, can be dropped anywhere on the
   sample zone window and on the device panel. On the window the zones go to the shown group, on the panel to the
   first group.
2. `SamplerZones.addSamples` in the adapters creates the zones and maps them by name. `SamplerSamples` in the app
   holds the file import and the drop target, the window and the panel share it.
3. Superseded by the editor rework below.

## Review and test pass 2026-11-12 (done, uncommitted)

Fixed after the code review:

1. Importing again into a Sampler that already used the same samples left zones without a sample. The new zones
   are now created before the old ones go.
2. A short loop played far above its root ran out of its loop points and held one value.
3. Release samples ignored the Voices limit.
4. Round robins counted per key. A stack now takes turns across all its keys.
5. Export SF2 kept every round robin when all had sequence 1. It keeps the first of each stack.
6. Duplicate gave every copy of a stack the same sequence.
7. Imports and drops keep the project they started in when it is closed or replaced meanwhile. Files that cannot
   be read are reported, a batch shows its progress.
8. A drop that adds nothing keeps the selection. The window title no longer shows a stale name.

Left from the review, not fixed:

1. Parse helpers return `Optional` where the code style asks for `Option` (`SamplerValueLabel.Field.parse` and
   its formats, `SamplerSfz.parseKey`, `framesOf`).
2. Group and trigger names, note parsing and the find-or-create of a sample file box exist more than once.
3. A zone's `index` is the zone count, which can repeat after Clean Up. Only the order uses it.
4. The playhead canvas is resized on every position update.
5. Some two line comments.

Browser, on a fresh project: add Sampler, drop samples on the panel and the window, type and drag values, play
keys, groups, modulation, export dialog, undo back to an empty project with the window open, playback of the
imported Steinway. No console errors. Not tested: saving the exported file and the import, both need the native
file dialog.

## Next

1. Scripting API. The shape is worked out on an example in `plans/sampler-scripting.md`.
2. Release notes with the DEV deploy.
3. A preview in the import dialog. SFZ `#include`. Groups cannot be deleted yet.

## Later

1. Chop a sample onto the keys: import one sample, cut it at its transients or on the grid, and place the slices
   on consecutive keys as zones of the same file (sample start and end per zone).
2. Envelope and LFO per zone. The device's stay the default, a zone can override them with a box of its own
   attached to it. The engine can deliver those as a second table joined to the zones, no new mechanism. Overrides
   would not be automatable. Soundfont import could then keep the envelopes per zone.
3. Mod Wheel, Aftertouch and Bend, once openDAW supports them.
4. Sample bit depth, `plans/sample-bits.md`.

## Decided 2026-11-12

1. Velocity to Gain starts at 100%.
2. Left and right samples that the soundfont does not mark as linked stay mono zones. No merging by name.
3. Keeping the bit depth of the source is its own plan, `plans/sample-bits.md`. The Sampler stays on floats.
4. The Groups list stays visible with a single group.

## Open

1. A zone edit delivers the whole zone table again. Fine for hundreds of zones, to be measured for thousands.

## Editor rework 2026-11-12 (done, uncommitted)

Goal: everything the engine understands can be edited in the window, and round robins are built by hand.

1. **Samples** list replaces the per zone list: one row per sample with its number of zones, a click selects all
   of them.
2. **Zones on This Range**, right of the waveform: the zones on the keys and velocities of the selected zone, each
   with pan and gain. Click focuses one zone. A menu in its head sets how they play (Together, In Turn, Random),
   which is the group's round robin setting. With In Turn the rows are numbered and dragged into order. The ×
   takes a zone off the map.
3. **Drops decide by place**: empty map puts the sample on the key under the pointer, a rectangle or the range
   list adds a zone to that range, the waveform replaces the sample of the focused zone. Elsewhere a single
   sample in an empty Sampler gets the whole keyboard and several line up from C1. A second sample added to
   that single one turns both into a kit.
4. **Groups** can be deleted (× on the row, asks when the group has zones, the last group stays).
5. **Choices are menus**: Stacks, Trigger and Loop open a menu instead of being dragged.
6. **Sample markers**: start, end and the loop points are dragged in the waveform.
7. **Disagreeing values**: a field turns cream when the selected zones differ, the tooltip names lowest and
   highest.
8. The map labels a range only when its zones take turns ("rr 3"). Layers are not labelled.
9. Adapters: `SamplerZones.addToStack`, `replaceSample`, `reorder`, `removeGroup`, `fileOf`, and the key placement
   in `addSamples`. 18 new tests.

Every field of the boxes now has a control: all zone fields, the zone's sample (drop on the waveform), its group (Move
to Group), enabled (Delete, Restore), the group's label, stacks, choke and trigger, the modulation slots and the
device parameters.

Review rounds on this rework: five, each followed by fixes. The last one found ten more, all in the edges of the
drop rules and the range list. They are fixed, but that round was not followed by another review.

Not confirmed in the browser: drops on the device panel, on the range list and on the waveform. The automated
drag releases without a hover event, so those drops do not register. Drops on the map do. All drop rules are
covered by the adapter tests (62 in `SamplerZones.test.ts`).

Left open from the reviews: the range and turn order are computed twice per refresh, and the five older items
under "Review and test pass".

Decided without André, to confirm:

1. A deleted group takes its zones with it. Moving them to another group would let release samples sound on
   attack.
2. Round robin stays a setting of the group, shown where the zones of a range are listed.
3. × in the range list takes the zone off the map like Delete does. Clean Up removes it for good.
4. Seq is called Turn and only shows a value with In Turn.
5. Replacing a zone's sample resets its start, end and loop points to the whole sample.
6. The names Together, In Turn and Random replace Off, Cycle and Random.
7. Samples without a note in their name: one alone keeps the whole keyboard, a second one turns both into a kit
   from C1, and layers or round robins of one instrument (`Snare v1`, `Snare rr2`) share its key.
8. A drop on the waveform replaces the sample of the selected zone. The range list always adds.
9. Round robins numbered in file names switch an empty group to In Turn.
10. Keys that other groups play count as taken when a free key is searched, unless a zone there covers the whole
    keyboard.

## Open questions for André

Design

1. The ten decisions above.
2. Envelope and LFO per zone as override boxes (see Later). Build it, and before or after the first release?
3. Round robins take turns per range, across all keys the range covers. Before, every key counted on its own.
4. The window title is just "Sample Zones", the instrument name is the first thing inside.
5. In your Steinway `Piano.ff.C1L` is panned 100 R and `C1R` 100 L. Is the soundfont authored that way, or does the
   import flip the pan? It needs the file to check.

Import and export

6. Export SF2 leaves out further round robins, release triggers, fades, One Shot, the mod envelope, LFOs and
   modulation. One Shot could be written as a long release, and LFO to pitch as SF2 vibrato. Worth it?
7. Export clips samples louder than full scale after asking. Offer to normalise the whole instrument instead?
8. Import takes the envelope and filter of the first zone for the whole instrument. Fine until per zone overrides
   exist?
9. The Soundfont device stays next to the Sampler for now. When does it go, and are existing projects converted
   on load?

Scripting

10. The five points under Open in `plans/sampler-scripting.md`.

Release

11. The export was written against the soundfont reader we use. It has not been opened in another soundfont
    player. Do you have one at hand to try a file?
12. Which CC0 libraries ship first under `Multi Samples` in the cloud (VCSL, the mridangam set)?
13. Release notes go in with the DEV deploy. Deploy to DEV now, or after the scripting API?
