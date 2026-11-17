# Soundfonts play in the Sampler first

The Soundfont device cannot change presets by automation and does not follow the SF2 velocity curve (it is left as
it is, no fix). The Sampler follows the spec (Velocity to Gain slot at 1.0 = the SF2 default modulator, checked
against spessasynth). So every way to use a soundfont leads to a Sampler first, the Soundfont device stays for old
projects and as a second choice. No automatic conversion of existing projects.

## One flow: soundfont into a Sampler

1. Load the soundfont in a progress dialog (library file or disk file), read by `ExternalLib.Soundfont`.
2. One preset: applied at once. Several: the preset picker (`bank:program name`).
3. The preset goes into a new Sampler, or into the Sampler it was dropped on. Its samples are stored in the sample
   library under a folder named after the soundfont (today "Multi Samples").

## Entry points

1. Library browser, Soundfonts tab: double-click a soundfont (new) and the first right-click item "Create Sampler"
   run the flow. "Create Soundfont Device" stays below it.
2. Dropping a library soundfont onto the timeline (new track) or onto a Sampler runs the flow (new).
3. Device browser dialog: soundfont entries create a Sampler with the flow ("Soundfont for Sampler").
4. Tour text: soundfonts play in the Sampler.

## Not changed

1. The Soundfont device, its editor, scripting `Soundfont` instrument, presets and templates that use it.
2. Import of soundfont files into the library (menu, Spotlight, drop on the tab).
