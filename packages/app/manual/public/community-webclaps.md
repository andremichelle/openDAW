# Community WebCLAPs

Community WebCLAPs are plugins shared by openDAW users. They live next to the
[Community Scripts](/manuals/community-scripts) in the public GitHub repository
[opendaw-commons](https://github.com/andremichelle/opendaw-commons). Anyone can add one, and once it is accepted it
shows up in every openDAW Studio, without a Studio update.

## Using community WebCLAPs

1. Add a [WebCLAP](/manuals/devices/audio/wclap) instrument or audio effect.
2. Click **Load Plugin > Cloud** and open the **Community** folder.
3. Pick a plugin. It is downloaded the first time and stays on your computer afterwards.

The source code and history of every plugin are in its folder on GitHub.

## Sharing your own plugin

WebCLAP plugins are shared as source code, never as a built file. The check builds every plugin with a fixed
toolchain, so the plugin people load always matches the code that was reviewed. You need a free
[GitHub](https://github.com/) account and a plugin that builds with Emscripten.

### 1. Choose a folder name

The folder name (the "slug") identifies your plugin for good. Use lowercase letters, digits and single hyphens, for
example `tape-saturation`. It must not be taken yet, and it never changes after your plugin is accepted. The name
people see is separate and can be changed any time.

### 2. Prepare the folder

Create `wclaps/<slug>/` with a `meta.json` and a `source/` folder. `wclaps/simple-sine` is a complete example in
plain C, the easiest start is a copy of it.

```json
{
  "name": "Tape Saturation",
  "description": "Warm tape style saturation with a drive and a tone control.",
  "author": {"name": "Your Name", "github": "your-github-name"},
  "tags": ["distortion", "warm"],
  "license": "MIT",
  "credits": "Built on the CLAP headers by free-audio (MIT)."
}
```

The name has at most 64 characters, the description at most 1000. Use up to 8 tags, lowercase words joined by
hyphens. `license` is the SPDX id of your source license, and `credits` names the code you built upon.

### 3. Write the build script

`source/build.sh` builds the plugin. The check runs it with Emscripten 3.1.51 and two variables:

1. `$CLAP_INCLUDE` is the folder with the CLAP headers (free-audio/clap 1.2.10), the one that holds `clap/clap.h`.
2. `$OUT` is an empty folder. Write `module.wasm` there, plus your plugin page and its files if it has one.

`module.wasm` exports `clap_entry`, `malloc` and its function table and imports nothing but WASI. The repository's
[CONTRIBUTING.md](https://github.com/andremichelle/opendaw-commons/blob/main/CONTRIBUTING.md) lists the exact
Emscripten flags.

### 4. Open the pull request

Fork [opendaw-commons](https://github.com/andremichelle/opendaw-commons), add your folder to `wclaps/` in the fork,
and open a pull request against `main` with a sentence or two about your plugin. For a plugin with several source
files, the GitHub command line or GitHub Desktop is easier than uploading in the browser.

## What happens after you open a pull request

1. **The check runs.** It checks the folder name, `meta.json` and the size limit, builds your plugin and loads it.
2. **A comment appears** with the plugins it found, or a list of what has to be fixed. The check runs again on every
   change to your branch.
3. **Anyone can try it before it is accepted.** Open the check on GitHub, download **wclap-bundles** from the run's
   summary page and unzip it. In the Studio, add a WebCLAP device, click **Load Plugin > Import WebCLAP...** and pick
   the file.
4. **A maintainer reviews it.** Plugins run in other people's browsers, so every pull request is read by a person
   before it is accepted.
5. **It goes live.** After the merge it takes a minute or two until it is published. Reload the Studio to see the
   new plugin.

## Changing a plugin

Improvements work the same way. Edit the folder of an existing plugin in your fork and open a pull request. The
folder name stays, so it remains the same plugin.

## Rules

1. The source code may use any OSI approved license. Name it in `license` and give credit in `credits`.
2. Sounds a plugin ships must always be released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
3. The `source/` folder is at most 20 MB.
4. Only source code goes into the repository, never a built `.wasm` or bundle.
