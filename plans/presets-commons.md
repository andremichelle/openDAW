# Presets in opendaw-commons

All stock presets move from `assets.opendaw.studio/presets` into opendaw-commons, next to scripts and WebCLAPs.
Users contribute presets by pull request. Extracted from `plans/sampler-library.md` (#255), whose VCSL presets are
the first new content.

## DEV and PROD

Cloud assets have no DEV or PROD scope, DEV and PROD read the same index files. Presets that need a feature only
DEV has are collected in a staging folder and move into the PROD folder on launch day, so nothing reaches PROD
before PROD can read it. No `minApi` gate for presets.

1. `presets/` is PROD content, fully validated against the SDK on `latest`.
2. `dev/presets/` collects presets for the next release. Only `meta.json` is checked before the merge, the binary
   is tested on DEV.
3. The deploy writes one index per folder. DEV builds read both, PROD reads only `presets/`.
4. Launch day, after the Studio deploy: move `dev/presets/*` into `presets/` with a script, validate, merge,
   deploy. The steps are in `UPDATE.md`.

## History

Presets were part of `plans/community-repo.md` (`presets/<slug>/meta.json + preset.odp`) and were dropped from
commons on 2026-10-22, because the tools would need studio-core and studio-boxes. They come back on the published
SDK. The validation and deploy rules of that plan (asset reference check, indices uploaded last) apply
unchanged.

## Phases

### 1. Presets in opendaw-commons

1. Layout `presets/<folder>/<name>/meta.json + preset.odp`, staging `dev/presets/<folder>/<name>/`. `<folder>` is
   the device in lowercase with hyphens (`dattorro-reverb`), `racks`, `audio-effect-chains` or `midi-effect-chains`.
2. `schemas/preset.meta.json`: name, description, author, tags, license, credits, device, folder. The uuid comes from
   the path like for scripts, without the `dev/` prefix, so the move keeps it. The category comes from the folder
   and the device. License is `CC0-1.0` or `CC-BY-SA-4.0`. CC-BY-SA requires `credits`, like WebCLAPs.
3. Validator for `presets/`: decodes the preset with the SDK on `latest`, the device must exist, size limit, and
   every `AudioFileBox` must be a cloud sample (index or `get.php`). Local samples are rejected with a message that
   says so. A dev preset must not exist in `presets/` already. `dev/presets/` checks `meta.json` only.
4. Build and deploy write `community/presets/index.json`, `community/dev/presets/index.json` and the payloads.
5. Launch script: moves `dev/presets/*` into `presets/` and runs the full validation.
6. Before the first deploy with presets: build the indices with and without presets and compare. PROD reads the
   scripts and WebCLAP indices, they must stay byte identical.
7. README and CONTRIBUTING.md: presets are CC0 or CC-BY-SA, everything else stays as it is.
8. First content: 71 of the 72 presets in `assets.opendaw.studio/presets` (all but TB-303 Bassline) move into commons with their uuids, author
   `openDAW`, license `CC-BY-SA-4.0`. They test the validator and the deploy and stay invisible until phase 2.
   From the day of the copy the admin and the Studio upload are no longer used for presets, so the old index stays
   as copied.
   Presets needing boxes that are not on `latest` yet (VCSL if the Sampler is not released) go to `dev/presets/`.

### 2. Studio reads commons presets

1. `CommunityIndex.parsePresets` reads `presets/`, DEV builds also `dev/presets/`.
2. `PresetService` takes commons presets as its stock presets and stops reading the old index. The old index stays
   frozen on the server for older builds.
3. Folders shown in the preset browser.
4. The info card shows Author and License for presets (`DeviceCatalog.presetEntry` shows only Device and Timeline
   today). A preset playing CC-BY-SA samples says that songs using it fall under CC-BY-SA.

### 3. Upload route

1. The access key upload (`PresetService`, `TubularAudition`) is replaced by the pull request route.

### 4. User contributions

1. **Save for Community…** on a user preset saves its `preset.odp`, the user writes `meta.json` on GitHub.
2. Manual page like `/manuals/community-scripts`, step by step.

### 5. Admin teardown, after the release that reads commons on PROD

The admin is not used for presets since the copy in phase 1.

1. admin.opendaw.studio drops the preset catalogue and `upload-preset.php`, `update-preset.php`,
   `delete-preset.php`.
2. `api.opendaw.studio/presets/upload.php` goes.
3. `presets/index.json` and the `<uuid>.odp` files stay on the server, frozen. Nothing writes to them any more.

### 6. Download size

A preset with big samples (a multi-sampled instrument) loads tens of MB. The Device Browser shows the size and asks
before loading, like it does for soundfonts and WebCLAPs.

1. The commons build lists the cloud samples and soundfonts of every preset, `presets/` and `dev/presets/`. It reads
   the box names and uuids from the file without decoding the boxes, so this also works for boxes the SDK does not
   know yet.
2. The build asks the cloud for each file's size (HEAD) and writes `samples`, `soundfonts` and `downloadSize` (the
   total in bytes, 0 if a size is unknown) into the index entry. Nothing in `meta.json`.
3. The Studio gives such a preset a download: size, and stored once every sample and soundfont is in the local
   storage. From 500 KB it is large and needs **Load** like a soundfont. An unknown size counts as large.
4. The info card shows the size.

## Related plans

1. `plans/sampler-library.md`: VCSL and mridangam Sampler presets, generated into commons after phase 1.
2. `plans/device-browser-dialog.md`: stock presets carry their tags from commons, user presets get a tags field.
3. `plans/preset-folders.md`: folders for user presets only, stock presets stay flat. Commons folders change the
   second half, the browser shows stock folders from phase 2.
4. `plans/browser-tabs.md`, `plans/spotlight.md`: list `PresetService.presets()`, so commons presets appear there
   without own work.
5. `plans/tauri.md` phase 2: offline download of the cloud presets reads the commons index instead.
6. `plans/opfs-storage-page.md`: user presets only, not affected.

## Decided

1. Presets never bring samples of their own. They play cloud samples only.
2. Layout like scripts, `presets/<folder>/<name>/`, lowercase device folders plus `racks` and the two chain folders.
   The uuid comes from the path. The browser folder lives in `meta.json`.
3. License per preset. The existing stock presets are `CC-BY-SA-4.0` by `openDAW`. New presets bring their own:
   VCSL presets are CC0, the mridangam preset is CC-BY-SA with credits for its samples.
4. Share-alike of CC-BY-SA samples reaches the songs made with them, the preset license does not change that. Such
   presets say so in the UI.
