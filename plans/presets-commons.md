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
4. Launch day: publish the SDK, move `dev/presets/*` into `presets/` with a script, validate, merge, deploy. The
   steps are in `UPDATE.md`.

## History

Presets were part of `plans/community-repo.md` (`presets/<slug>/meta.json + preset.odp`) and were dropped from
commons on 2026-10-22, because the tools would need studio-core and studio-boxes. They come back on the published
SDK. The validation and deploy rules of that plan (asset reference check, indices uploaded last) apply
unchanged.

## Phases

### 1. Presets in opendaw-commons

1. Layout `presets/<device>/<slug>/meta.json + preset.odp`, staging `dev/presets/<device>/<slug>/`.
2. `schemas/preset.meta.json`: uuid, name, description, author, tags, license, credits, category, device, folder.
   The uuid is written into `meta.json` when the preset is added and never changes, so a move out of `dev/` keeps
   it. Stock presets keep their existing uuid. License is `CC0-1.0` or `CC-BY-SA-4.0`. CC-BY-SA requires `credits`,
   like WebCLAPs.
3. Validator for `presets/`: decodes the preset with the SDK on `latest`, the device must exist, size limit, and
   every `AudioFileBox` must be a cloud sample (index or `get.php`). Local samples are rejected with a message that
   says so. Uuids are unique across both folders. `dev/presets/` checks `meta.json` only.
4. Build and deploy write `community/presets/index.json`, `community/dev/presets/index.json` and the payloads.
5. Launch script: moves `dev/presets/*` into `presets/` and runs the full validation.
6. Before the first deploy with presets: build the indices with and without presets and compare. PROD reads the
   scripts and WebCLAP indices, they must stay byte identical.
7. README and CONTRIBUTING.md: presets are CC0 or CC-BY-SA, everything else stays as it is.
8. First content: the 72 presets in `assets.opendaw.studio/presets` move into commons with their uuids, author
   `openDAW`, license `CC-BY-SA-4.0`. They test the validator and the deploy and stay invisible until phase 2.
   Presets needing boxes that are not on `latest` yet (VCSL if the Sampler is not released) go to `dev/presets/`.

### 2. Studio reads commons presets

1. `CommunityIndex.parsePresets` reads `presets/`, DEV builds also `dev/presets/`.
2. `PresetService` takes commons presets as stock presets. The old cloud index stays as fallback until phase 3.
3. Folders shown in the preset browser.
4. The info card shows Author and License for presets (`DeviceCatalog.presetEntry` shows only Device and Timeline
   today). A preset playing CC-BY-SA samples says that songs using it fall under CC-BY-SA.

### 3. Studio stops reading the old index

1. The Studio reads commons only. The old index stays frozen on the server for older builds.
2. The access key upload (`PresetService`, `TubularAudition`) is replaced by the pull request route.

### 4. User contributions

1. A preset exports as `meta.json + preset.odp` ready for a pull request.
2. Manual page like `/manuals/community-scripts`, step by step.

### 5. Admin teardown, after the release that reads commons on PROD

Until that release PROD reads `assets.opendaw.studio/presets/index.json` and the admin is the only way to fix it.

1. admin.opendaw.studio drops the preset catalogue and `upload-preset.php`, `update-preset.php`,
   `delete-preset.php`.
2. `api.opendaw.studio/presets/upload.php` goes.
3. `presets/index.json` and the `<uuid>.odp` files stay on the server, frozen. Nothing writes to them any more.

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
2. Layout by device, `presets/<device>/<slug>/`. The browser folder lives in `meta.json`.
3. License per preset. The existing stock presets are `CC-BY-SA-4.0` by `openDAW`. New presets bring their own:
   VCSL presets are CC0, the mridangam preset is CC-BY-SA with credits for its samples.
4. Share-alike of CC-BY-SA samples reaches the songs made with them, the preset license does not change that. Such
   presets say so in the UI.
