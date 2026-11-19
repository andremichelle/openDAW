# Sampler Library (#255)

The CC0 instruments of VCSL and the mridangam set ship as ready to play Sampler presets. The presets live in
opendaw-commons next to scripts and WebCLAPs, so users can contribute presets by pull request too.

## What ships

1. VCSL ([sgossner/VCSL](https://github.com/sgossner/VCSL)), CC0. 4,231 WAVs, 6.15 GB. The 9 "Legacy" folders are
   older recordings replaced by newer ones and are skipped. That leaves 3,822 files, 5.76 GB, 93 instruments.
2. Mridangam ([yaxu/mrid](https://github.com/yaxu/mrid)), CC-BY-SA 4.0. 131 strokes, about 37 MB. Credit to Arthur
   Carabott and performer Harishankar V Menon.
3. Formats are mixed (Claves are 44.1 kHz 16 bit stereo). Format and channels stay as they are.
4. Tails are cut 100 ms after the sample falls below -60 dB of its own peak, with a 100 ms fade. On Vibraphone
   Hard Mallets this saves 28% (40 MB to 29 MB). Mono is no option: the recordings are real stereo.

## Why it does not wait for PROD

Cloud assets have no DEV or PROD scope. Two facts make that unnecessary here.

1. A cloud sample loads by its uuid even without an entry in `samples/index.json` (`OpenSampleAPI.get` falls back
   to `get.php`). The samples can be uploaded now and stay invisible in the sample browser.
2. Presets in opendaw-commons are read only by DEV builds until the next release (`plans/presets-commons.md`).

The sample index entries (`Multi Samples`) are the only part that must wait for the PROD release.

## Sample paths and names

```
openDAW/Multi Samples/
  VCSL/        Vibraphone/Hard Mallets · Vibraphone/Soft Mallets · Marimba · Glockenspiel · ...
  Mridangam/   the 131 strokes of the mrid set
```

1. One folder per source. VCSL instruments sit directly under `VCSL` with their VCSL names.
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
5. Name, tags, folder and a description with the source. VCSL presets are CC0, the mridangam preset is CC-BY-SA
   with credits (`plans/presets-commons.md`).

## Phases

### 1. Samples

1. Clone VCSL and mrid into the scratchpad.
2. A staging script builds the target tree and a manifest (source path, folder, name). Reviewed before upload.
3. `scripts/upload-samples.mjs` writes a results file (path to uuid) and skips what it already holds, so a run of
   about 4,000 uploads resumes after a failure. `--bpm 0 --origin openDAW`.
4. No index entries yet.

### 2. Presets in opendaw-commons

Own plan, `plans/presets-commons.md`. Phase 3 below needs its phase 1 (commons presets with the Sampler boxes in
the SDK) and its phase 2 (the Studio reads them).

### 3. VCSL presets

1. A generator in node builds every Sampler with `SamplerZones` from the manifest of phase 1 plus the override
   table, encodes it with `PresetEncoder` and writes the commons files.
2. Headless check in core-wasm: every key of every preset is played, silent keys, clipping and broken layers are
   listed.
3. André listens to a short list in the Studio on DEV.
4. Pull request to commons.

### 4. With the PROD release

1. `Multi Samples` entries in `samples/index.json` from the results file.
2. Credits for VCSL and the mridangam set in the manual.
3. Release notes.

## Open questions

1. 24 bit to 16 bit before upload, against `plans/sample-bits.md`?
2. Steinway B: Sus and NoSus as two presets, or one?
3. Xylophone, Harpsichord Flemish and Renaissance Organ have two microphone positions. One preset each, or one per
   position?
