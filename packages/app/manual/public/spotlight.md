# Spotlight

The Spotlight is a command line for the studio. Press **Shift+Enter** or **⌘+F** anywhere, start typing, and
press **Enter** to run the highlighted entry. It creates instruments, effects, presets and script devices, opens
projects and files, and takes you to any place in the studio. It works with or without a project.

## Typing a query

Just type what you are looking for. `vapo` finds the Vaporisateur, `delay` finds the Delay, `mixer` goes to the mixer.
Every word you type has to match the start of a word, so `pre` finds Preferences but not Compressor. Words typed
without their spaces still match, `fadein` finds a script called Fade In.

* **↑** and **↓** move the highlight
* **Enter** runs the highlighted entry, a click does the same
* **Escape** closes the Spotlight
* Drag the Spotlight by its frame to move it, it opens at the same place next time

## Verbs

A query can start with a verb. The verb limits the search to what it can do. Without a verb, everything but samples is searched.

| Symbol | Word     | What it does                                     | Example                  |
|--------|----------|--------------------------------------------------|--------------------------|
| `+`    | `create` | Creates a device, a preset, a script device      | `+vapo`, `create delay`  |
| `/`    | `open`   | Opens a project or bundle, imports files         | `/bundle`, `open stems`  |
| `@`    | `goto`   | Goes to a place or a screen                      | `@mixer`, `goto pref`    |
| `~`    | `sample` | Creates a Tape track with a sample               | `~kick`, `sample vocal`  |

The symbol needs no space, `+vapo` is enough. A word needs a space after it, and its first letters are enough:
`cr vapo` means `create vapo`. **Tab** completes a verb you started typing.

A symbol or a complete word turns into a label in front of the input. **Backspace** on an empty input removes it.

A verb on its own, like `+` or `/`, lists all its entries with the ones you use most at the top.

The legend under an empty Spotlight shows which verbs are available right now.

## Creating devices

* **Instruments** are created on a new track, right after the track you are editing. Without one they are added after
  the other instruments.
* **Effects** are added to the end of the effect chain of the track you are editing.
* **Presets** are found by their own name. `pad` lists every preset with Pad in its name. Add the device name to narrow
  it down: `vapo pad` lists only Vaporisateur presets.
* **Scripts** from the [Community Scripts](/manuals/community-scripts) create their device with the script already
  loaded: `wavetable` shows *Create Apparat with Wavetable script*.
* **WebCLAP plugins** from the openDAW cloud, the community and your own imports create a WebCLAP device with the plugin
  loaded. `webclap` lists all of them. A plugin not stored yet is downloaded first.

Entries that cannot run right now are greyed out and listed last, with the reason on the right. An effect for example
needs a track to be selected first.

Without a project, creating a device starts a new project first.

## Samples

The `sample` verb searches the openDAW library and your own samples. **Enter** creates a new Tape track with the sample.
Samples only appear with the verb, a search without a verb leaves them out.

The word `loop` keeps only loops (samples with a tempo), `noloop` or `oneshot` keeps only one-shots: `~kick loop`.

## Browsing presets and scripts

A device with presets or scripts shows how many it has, with an arrow. Press **→** or click the arrow to list all of
them, then type to filter. **←**, **Backspace** on an empty input or **Escape** go back.

## Opening and importing

The `open` verb opens projects and bundles, imports audio files, stems, soundfonts, preset bundles and DAWproject
files, and starts Neural Demux. Each one shows the same dialog as its entry in the studio menu.

## Places

The `goto` verb takes you to the Dashboard, Scripting, Preferences, Storage, the Manuals and other pages, at any time.
The screens of a project (Arrangement, Mixer, Modulation and the others) need an open project.

`create` also offers a new project and a new live room, with or without a project.
