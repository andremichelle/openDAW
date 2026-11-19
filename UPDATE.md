# PROD Update

Everything that has to happen on the day the next version goes to PROD, in order. Collected while working on DEV.
Each entry names the plan it comes from.

## Before the deploy

1. Publish the SDK packages from the release state, so `latest` knows every box of the release.
2. Sampler library (`plans/sampler-library.md`): add the `Multi Samples` entries to `samples/index.json` from the
   upload results file.

## With the deploy

1. Release notes in `releases/`.
2. Credits for VCSL and the mridangam set in the manual.

## After the deploy

1. Presets (`plans/presets-commons.md`): in opendaw-commons update the validator to the new SDK, run the launch
   script that moves `dev/presets/*` into `presets/`, check that the full validation passes, merge and deploy.
2. Check on PROD that the stock presets and the moved presets load.
3. Presets: tear down the preset section of admin.opendaw.studio and `api.opendaw.studio/presets/upload.php`
   (`plans/presets-commons.md` phase 5). `presets/index.json` and the `.odp` files stay on the server for older
   builds.
