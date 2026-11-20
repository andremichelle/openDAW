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
   2. 44 instruments carry no note. All are drums and percussion and become kits, one key per sound from key 60, with
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
4. **Upload.** `scripts/sampler-library/upload.sh <stage dir> <slug>` (it reads the access code from the
   `api.opendaw.studio` checkout), which calls `scripts/upload-samples.mjs --bpm 0 --origin openDAW --results
   <stage dir>/<slug>/results.json`. Names already in the cloud are skipped, the uuids are looked up by name through
   `list.php` (all VCSL file names are unique) and written into `results.json`.
5. **Build.** The same script builds the Sampler again from the cloud samples, `encodePreset()` returns the
   `preset.odp`, which comes out of the agent result as base64. `scripts/sampler-library/check.mts <stage
   dir>/<slug>`, run from `../opendaw-commons-main/tools`, checks that the file uses exactly the uploaded uuids.
6. **Meta OK.** André sees the composed `meta.json` before the PR: name, description with the recorded range,
   author Versilian Studios, CC0, credits to VCSL, device Sampler, folder.
7. **Commons.** `scripts/sampler-library/publish.sh <stage dir> <slug> "<Name>"` opens the pull request into
   `dev/presets/sampler/<slug>/`, merged once the check passes, the deploy lists it
   on dev.opendaw.studio with its download size. This runs in the background while the next preset is staged and
   auditioned. A push that only touches presets deploys in about a minute.

A playing style that sounds too close to one already published is skipped, near duplicates only add noise to the
list.

Pitch is measured, not taken from the names: many VCSL folders name their notes one octave low. The measurement reads
the sample rate from each file (some folders are 48 kHz), and the zones get the sample rate of their file.

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
| Xylophone Medium, Hard, Soft Mallets | live on DEV |
| Tubular Bells, Tubular Glockenspiel, Balafon Hard Mallet | live on DEV |
| Balafon Traditional Mallet | skipped, too close to Balafon Hard Mallet |
| Kalimba, Tanzania | dropped after audition, Kalimba Kenya skipped with it |
| Folk Harp | live on DEV |
| Strumstick | dropped after audition |
| Harmonica Super64 | dropped after audition, the other harmonicas skipped with it |
| Didgeridoo | dropped after audition |
| Upright Piano, Yamaha | live on DEV, 16 bit, 132 MB |
| Harpsichord, Italian | dropped after audition, the other harpsichords skipped with it |
| Grand Piano Kawai, Steinway B, Upright Knight | skipped, enough pianos |
| Renaissance Organ, Pipe Organ Pedal | live on DEV |
| Tenor Saxophone, Saxello | dropped after audition (the first sax audition was mistuned by my 44.1 kHz assumption on 48 kHz files) |
| Ocarina | live on DEV |
| Baroque Recorders | skipped, very uneven levels (-8 to -34 dB) |
| Pipe Organ Pedal | live on DEV, 22.9 MB |
| Dan Tranh | dropped after audition, the other Dan Tranh styles skipped with it |
| Snare Drum, Ocarina | live on DEV |
| Cajon, Darbuka, Bongos | live on DEV |
| Bass Drum 2 | dropped after audition |
| Hi-Hat, Toms, Suspended Cymbal, Clash Cymbals, Gong | live on DEV |
| Timpani 1 (hits and rolls) | dropped after audition, Timpani 2 skipped with it |
| Conga, Frame Drum, Cowbells | live on DEV |
| Percussion Kit (Woodblock, Claps, Shaker Large, Slapstick, Anvil, Brake Drum) | live on DEV, Brake Drum 2 bowed dropped |
| Mbira | dropped after audition, Nyunga Nyunga skipped with it |
| Bass Drum 1 | dropped after audition |
| Concert Harp | live on DEV, 71 MB |
| Snare Drum Modern 2 and 3, Rope Tension, Suspended Cymbal 2, Tubular Bells 2, Ocarina SusVib | skipped, second takes |

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
