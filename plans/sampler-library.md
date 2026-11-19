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
4. Melodic presets extend the lowest zone down to key 0 and the highest up to 127, so no key is silent. Kits and
   single shots keep their exact keys.
5. Zones come from the same code a drop uses (`SamplerZones`):
   1. 42 instruments carry a note in every file name and map on their own.
   2. 44 instruments carry no note. All are drums and percussion and become kits, one key per sound from C1, with
      velocity layers and round robins.
   3. 7 are partly named (Pipe Organ, Dan Tranh, Upright Piano Knight, Bell Tree, Clash Cymbals 2, Suspended
      Cymbals 1 and 2). They and Timpani (`Timpani1C_hit`, no octave) get a small override table.
6. Name, tags, folder and a description with the source. VCSL presets are CC0, the mridangam preset is CC-BY-SA
   with credits (`plans/presets-commons.md`).

## Workflow per preset

One preset at a time, André checks every one before anything reaches the cloud or commons. This runs over days.

1. **Stage.** `node scripts/sampler-library/stage.mjs --folder "<VCSL folder>" --slug <slug> --out <stage dir>`
   downloads the folder, cuts the tails and writes the files with a `manifest.json` into `<stage dir>/<slug>/`. It
   prints every file's length before and after the cut and its peak. A folder recorded far below full scale
   (Vibraphone Bowed peaks at -26 to -44 dB) is raised before it goes further, or dropped.
2. **Audition.** `node scripts/sampler-library/serve.mjs <stage dir>` serves the stage dir to the Studio (CORS and
   private network headers). A script run through the agent connection fetches the files, adds them to the local
   library with `openDAW.addSample` and builds the Sampler in a new project "<Name> Audition". Nothing is in the
   cloud yet.
3. **Sound OK.** André listens. Changes are made in the audition until he approves.
4. **Upload.** André runs `scripts/sampler-library/upload.sh <stage dir> <slug>` (it reads the access code from the
   `api.opendaw.studio` checkout), which calls `scripts/upload-samples.mjs --bpm 0 --origin openDAW --results
   <stage dir>/<slug>/results.json`. Names already in the cloud are skipped, the uuids are looked up by name through
   `list.php` (all VCSL file names are unique) and written into `results.json`.
5. **Build.** The same script builds the Sampler again from the cloud samples, `encodePreset()` returns the
   `preset.odp`, which comes out of the agent result as base64. A scan checks that every sample in the file is one
   of the uploaded uuids.
6. **Meta OK.** André sees the composed `meta.json` before the PR: name, description with the recorded range,
   author Versilian Studios, CC0, credits to VCSL, device Sampler, folder.
7. **Commons.** Pull request into `dev/presets/sampler/<slug>/`, merge, the deploy lists it on dev.opendaw.studio
   with its download size.

Mapping rules for melodic presets: every note in the file names becomes a root key, each zone reaches halfway to its
neighbours, the outer zones reach key 0 and 127. Dynamics become velocity layers that share 1 to 127 evenly.
Release 0.8 s for struck instruments.

## Status

| Preset | State |
|---|---|
| Vibraphone Hard Mallets | live on DEV, 22 samples, 30.4 MB |
| Vibraphone Soft Mallets | live on DEV, 22 samples, 35.3 MB |
| Vibraphone Bowed | dropped, recorded too quiet, and enough vibraphones |
| Marimba | dropped, recorded too quiet (loudest -14.8 dB, soft layer down to -68 dB) |
| Glockenspiel | dropped, recorded too quiet (loudest -23.4 dB) |

The survey (`plans/sampler-library-survey.md`) drops every folder whose loudest file stays below -12 dB: 92 presets
remain, 54 are dropped.

## Phases

### 1. Samples and presets, one by one

The workflow above, preset by preset. No index entries yet.

### 2. Presets in opendaw-commons

Own plan, `plans/presets-commons.md`. Done: commons presets, the Studio reads them, download size.

### 3. Later, if the one by one work shows a pattern

1. A generator in node builds the Samplers headless from the manifests.
2. Headless check in core-wasm: every key of every preset is played, silent keys, clipping and broken layers are
   listed.

### 4. With the PROD release

1. `Multi Samples` entries in `samples/index.json` from the results file.
2. Credits for VCSL and the mridangam set in the manual.
3. Release notes.

## Open questions

1. 24 bit to 16 bit before upload, against `plans/sample-bits.md`?
2. Steinway B: Sus and NoSus as two presets, or one?
3. Xylophone, Harpsichord Flemish and Renaissance Organ have two microphone positions. One preset each, or one per
   position?
