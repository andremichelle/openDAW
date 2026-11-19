# Community Presets

The stock presets in the Device Browser live in a public GitHub repository,
[opendaw-commons](https://github.com/andremichelle/opendaw-commons). Anyone can add one, and once it is accepted it
shows up in every openDAW Studio as a stock preset, without a Studio update.

## Sharing your own preset

You need a free [GitHub](https://github.com/) account. Everything below works in the browser, no command line and
no installed tools.

### 1. Save the preset in the Studio

Save your device as a preset (see [Presets](/manuals/presets)) and give it a good name and description. A preset can
only use samples and soundfonts from the openDAW cloud, samples you imported yourself are not available to other
users.

Select your preset in the Device Browser and click **Save for Community…**. This saves the file `preset.odp`.

### 2. Choose a folder

The folder of your preset is named after its device in lowercase, with hyphens between words: `vaporisateur`,
`delay`, `dattorro-reverb`, `stereo-tool`. Racks go into `racks`, effect chains into `audio-effect-chains` or
`midi-effect-chains`.

Inside it, your preset gets a folder of its own, named like the preset in lowercase letters, digits and single
hyphens, for example `warm-pad`. It must not be taken yet, and it never changes after your preset is accepted. The
name people see is separate and can be changed any time.

If your preset needs a feature that is only on [dev.opendaw.studio](https://dev.opendaw.studio) so far, it goes
into `dev/presets/` instead of `presets/`. It is listed on dev.opendaw.studio until the next openDAW release, and
then moves into `presets/`.

### 3. Open the pull request

1. Open [opendaw-commons](https://github.com/andremichelle/opendaw-commons) and go to `presets`. For a preset that
   needs dev.opendaw.studio, stay in the top folder and start the path in step 3 with `dev/presets/`.
2. Click **Add file > Create new file**. GitHub asks you to fork the repository, which creates your own copy. Accept.
3. Type the path of your `meta.json` into the name field, for example `vaporisateur/warm-pad/meta.json`. Every `/`
   creates a folder. Paste and adapt:

```json
{
  "name": "Warm Pad",
  "description": "A slow, warm pad with a soft filter sweep.",
  "author": {"name": "Your Name", "github": "your-github-name"},
  "tags": ["pad", "warm"],
  "license": "CC0-1.0",
  "device": "Vaporisateur"
}
```

4. Click **Commit changes…**, then **Propose changes**, then **Create pull request**, and describe your preset in a
   sentence or two.
5. On the pull request page, click the name of your branch, open your new folder `presets/vaporisateur/warm-pad`,
   click **Add file > Upload files**, drag `preset.odp` onto the page and click **Commit changes**. The file joins
   your pull request. Until it is there, the check reports it as missing.

What goes into `meta.json`:

1. `name` has at most 64 characters, `description` at most 1000, at least one sentence.
2. Up to 8 `tags`, lowercase words joined by hyphens. `author.github` and `author.url` are optional.
3. `device` is the device as the Studio names it: `Vaporisateur`, `Delay`, `DattorroReverb`, `StereoTool`. A rack
   names its instrument. A chain has no `device`.
4. `license` is `CC0-1.0` (anyone may use it for anything, without credit) or `CC-BY-SA-4.0`, which needs a
   `credits` field naming whom to credit.
5. `folder` is optional and places the preset in a folder of the preset browser, for example `"folder": "Pads"`.

## What happens after you open a pull request

1. **The check runs.** It takes about a minute. It checks the folders, `meta.json`, that the preset loads and holds
   its device, and that every sample it plays is in the openDAW cloud.
2. **A comment appears** with what goes live, or a list of what has to be fixed. To fix something, edit the file in
   your branch on GitHub. The check runs again on every change.
3. **A maintainer reviews it.**
4. **It goes live.** After the merge it takes a minute or two until it is published. Reload the Studio to see the new
   preset.

## Rules

1. Presets are released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/) or
   [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as their `meta.json` says. Only share presets you
   made yourself.
2. A preset plays samples from the openDAW cloud only, it never brings samples of its own. If it plays samples under
   CC-BY-SA, its description says that songs made with it fall under CC-BY-SA.
3. A preset is at most 1 MB.
