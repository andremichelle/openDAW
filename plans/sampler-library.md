# Sampler Library (#255)

The CC0 instruments of VCSL and the mridangam set ship as ready to play Sampler presets. The presets live in
opendaw-commons next to scripts and WebCLAPs, so users can contribute presets by pull request too.

## What ships

1. VCSL ([sgossner/VCSL](https://github.com/sgossner/VCSL)), CC0. 4,231 WAVs, 6.15 GB. The 9 "Legacy" folders are
   older recordings replaced by newer ones and are skipped. That leaves 3,822 files, 5.76 GB, 93 instruments.
2. Mridangam ([yaxu/mrid](https://github.com/yaxu/mrid)), CC-BY-SA 4.0. 131 strokes, about 37 MB. Credit to Arthur
   Carabott and performer Harishankar V Menon.
3. Formats are mixed (Claves are 44.1 kHz 16 bit stereo). Files are uploaded unchanged unless decided otherwise.

## Why it does not wait for PROD

Cloud assets have no DEV or PROD scope. Two facts make that unnecessary here.

1. A cloud sample loads by its uuid even without an entry in `samples/index.json` (`OpenSampleAPI.get` falls back
   to `get.php`). The samples can be uploaded now and stay invisible in the sample browser.
2. PROD reads presets only from `assets.opendaw.studio/presets`. Presets in opendaw-commons are read only by builds
   that have the new reader, which is DEV until the next release. Commons entries carry `minApi` (as scripts already
   do, `CommunityIndex.ApiLevel`), so later features can go to DEV first and stay hidden from an older PROD.

The sample index entries (`Multi Samples`) are the only part that must wait for the PROD release.

## Sample paths and names

```
openDAW/Multi Samples/
  Keys/        Grand Piano, Steinway B · Grand Piano, Kawai · Upright Piano, Knight · Upright Piano, Yamaha
               Harpsichord, English|Flemish|French|Italian|Unk · Pipe Organ · Renaissance Organ
  Mallets/     Vibraphone · Marimba · Xylophone · Glockenspiel · Tubular Bells 1|2 · Tubular Glockenspiel · Balafon
  Plucked/     Concert Harp · Folk Harp · Strumstick · Dan Tranh · Psaltery · Kalimba, Mbira, Nyunga Nyunga
  Winds/       Recorders · Ocarinas · Harmonicas · Tenor Saxophone · Saxello · Didgeridoo · Whistles · Siren
  Drums/       Bass Drum 1|2 · Snares · Toms · Timpani 1|2 · Bongos · Conga · Darbuka · Cajon · Frame Drum · Mridangam
  Percussion/  Cymbals · Gongs · Hi-Hat · Shakers · Tambourines · Triangles · Claves · Cowbells · Woodblock
  Synth/       TX81Z Clavisynth · TX81Z FM Piano · TX81Z Piano 1
```

1. Instrument folders keep their VCSL names.
2. A playing style (Staccato, SusVib, Hit, Soft Mallets) becomes a sub-folder only when an instrument has several.
3. A sample keeps its file name without `.wav` (`AltRecorder_Stac_A#3_rr1_Main`). Map by Name reads note, layer,
   dynamic and round robin from it, so a dropped cloud folder plays too.

## Presets

1. One preset per instrument and playing style. VCSL has 171 playing style folders, release folders included.
2. Release recordings (Releases, Rel) are no preset of their own. They join the matching sustain preset as a group
   with trigger Release.
3. Hi-hats get a choke group.
4. Zones come from the same code a drop uses (`SamplerZones`):
   1. 42 instruments carry a note in every file name and map on their own.
   2. 44 instruments carry no note. All are drums and percussion and become kits, one key per sound from C1, with
      velocity layers and round robins.
   3. 7 are partly named (Pipe Organ, Dan Tranh, Upright Piano Knight, Bell Tree, Clash Cymbals 2, Suspended
      Cymbals 1 and 2). They and Timpani (`Timpani1C_hit`, no octave) get a small override table.
5. Name, tags, folder, and a description with source and license.

## Phases

### 1. Samples

1. Clone VCSL and mrid into the scratchpad.
2. A staging script builds the target tree and a manifest (source path, folder, name). Reviewed before upload.
3. `scripts/upload-samples.mjs` writes a results file (path to uuid) and skips what it already holds, so a run of
   about 4,000 uploads resumes after a failure. `--bpm 0 --origin openDAW`.
4. No index entries yet.

### 2. Presets in opendaw-commons

Presets were dropped from commons on 2026-10-22 because the tools would need studio-core and studio-boxes. They
come back on the published SDK.

1. Layout `presets/<device>/<folder>/<slug>/meta.json + preset.odp`.
2. `schemas/preset.meta.json`: name, description, author, tags, license (CC0), category, device, folder, minApi.
   Stock presets keep their uuid in meta.json, so projects and preset cursors stay valid. New presets get the
   path derived uuid like scripts.
3. Validator: decodes the preset with the SDK, the device must exist, size limit, and every `AudioFileBox` must be a
   cloud sample (index or `get.php`). Local samples are rejected with a message that says so.
4. Build and deploy write `community/presets/index.json` and the payloads.
5. Needs an SDK publish that contains the Sampler boxes.

### 3. Studio reads commons presets

1. `CommunityIndex.parsePresets` with the `minApi` gate, `ApiLevel` raised.
2. `PresetService` takes commons presets as stock presets. The old cloud index stays as fallback until phase 4.
3. Folders shown in the preset browser.

### 4. Stock presets move

1. The 72 presets in `assets.opendaw.studio/presets` move into commons with their uuids.
2. The Studio stops reading the old index. The old index stays frozen on the server for older builds.
3. The access key upload (`PresetService`, `TubularAudition`) is replaced by the pull request route.

### 5. User contributions

1. A preset exports as `meta.json + preset.odp` ready for a pull request.
2. Manual page like `/manuals/community-scripts`, step by step.

### 6. VCSL presets

1. A generator in node builds every Sampler with `SamplerZones` from the manifest of phase 1 plus the override
   table, encodes it with `PresetEncoder` and writes the commons files.
2. Headless check in core-wasm: every key of every preset is played, silent keys, clipping and broken layers are
   listed.
3. André listens to a short list in the Studio on DEV.
4. Pull request to commons.

### 7. With the PROD release

1. `Multi Samples` entries in `samples/index.json` from the results file.
2. Credits for VCSL and the mridangam set in the manual.
3. Release notes.

## Open questions

1. Categories (`Multi Samples/Keys/...`) or a source level (`Multi Samples/VCSL/...`)?
2. 24 bit to 16 bit before upload, against `plans/sample-bits.md`?
3. Steinway B: Sus and NoSus as two presets, or one?
4. Xylophone, Harpsichord Flemish and Renaissance Organ have two microphone positions. One preset each, or one per
   position?
5. Commons is CC0 only. The mridangam preset is CC0 but plays CC-BY-SA samples. Allowed with a credit in its
   description, or does mridangam stay out of commons?
6. Do user presets need samples of their own one day (community samples), or do cloud samples suffice for now?
