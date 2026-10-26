# WebCLAP grain synth: Xenon

A granular instrument as a WebCLAP plugin that lives in openDAW's device panel (`opendaw:device-panel`,
`opendaw.device-panel/1`, see `plans/wclap-device-panel.md`). The sample is the centre of the interface: a glowing
waveform that reacts to every playing grain and takes a dropped audio file. Everything else is reduced to numbers,
small labels and coloured dots: no outlines, no panels, no boxes.

## Constraints

1. **Panel surface** is 176px high, the panel width at most 512px (`get_width` answers 512 for 176).
2. **Same bundle in every CLAP host.** Without the device-panel extension the page is the plugin window, the same
   layout scaled (window 1024 x 352, resizable, aspect kept).
3. **Pixel density.** Everything is drawn at `devicePixelRatio`, no bitmaps, so 1x, 2x and 3x are sharp.
4. **Plain CLAP, no JUCE**, C++ with Emscripten like WetChorus (`STANDALONE_WASM`, no env imports).

## Sound engine

1. **Grains.** Each grain reads the sample at a position, with a length, pitch, direction, envelope and its own
   filter and spatial placement. The scheduler emits grains at a density (grains per second) or synced to the
   host tempo, jittered by spray.
2. **Parameters, each with a per-grain random amount:**
    1. Position (0..1 of the sample), spray (random offset), scan (position movement per second)
    2. Size (1 ms .. 2 s), density (0.5 .. 200 grains/s), sync on/off
    3. Pitch (semitones, -48..+48), fine, random pitch, quantise random to a scale (off, octaves, fifths, major,
       minor)
    4. Reverse probability
    5. Envelope shape (one parameter morphing Gauss, Hann, triangle, exponential attack, exponential decay)
    6. Filter per grain: type (low, band, high), cutoff, resonance, cutoff random
    7. 3D per grain: azimuth (centre), spread, elevation, distance, distance random, motion (grains travel along their
       direction while they sound). Rendered binaural-ish with ITD, ILD and a head shadow filter, distance by gain,
       air absorption and a shared early reflection send. No HRTF sets.
    8. Amp envelope per voice (ADSR), gain, width
3. **Voices.** MIDI notes start voices, the note transposes the grains (key tracking on/off), velocity and
   aftertouch are modulation sources. Mono and poly mode.
4. **Grain pool.** Grains come from a pool of 128, preallocated at activate time, never allocated in `process`.
   A grain that finds the pool full is skipped.

## Modulation

1. **Sources:** 2 LFOs (shape, rate, sync, phase per voice or global), 2 envelopes (ADSR), per-grain random,
   velocity, note, mod wheel, aftertouch, and grain age (the grain's own lifetime, for movement inside a grain).
2. **Targets:** every continuous parameter above.
3. **Assignment** in the page: pick a source (its coloured dot), drag on a parameter to set the depth. The
   parameter shows the modulated range as a thin coloured arc or bar and the live value as a moving dot.
4. **Storage:** a depth for every source and target (a matrix, so no routing count), in the plugin state, applied
   on the audio thread. Grain age modulates while a grain sounds (pitch, cutoff, resonance, azimuth, elevation,
   distance, gain), every other source when the grain starts. Modulation depths are not CLAP parameters (hosts cannot automate them), only the base values are.

## Sample

1. **Import** by dropping an audio file on the waveform, or with the LOAD label (file picker). The page decodes it
   with `decodeAudioData` at 48 kHz, mixes it to mono and sends it to the plugin in chunks over `clap.webview`.
2. **State.** The sample is part of the plugin state as 16-bit mono PCM (the grains are mono sources placed in
   3D, so stereo would only double the size), after the parameters and the modulation, so a parameter change
   leaves the sample bytes untouched. At most 60 s (5.8 MB at 48 kHz), a longer file is cut with a note in the
   page.
3. **Waveform data.** The plugin answers the page with 2048 min/max peak columns, computed once per import, never
   on the audio thread.
4. **Handoff.** A new sample is built on the main thread and handed to the audio thread through an atomic slot,
   the replaced one comes back through a second slot and is freed on the main thread.

## Waveform view

Chosen in phase 0: the Energy style (`plans/wclap-grain-synth/phase-0.html`, frame B) in cyan.

1. **WebGL2**, one full-screen fragment shader over the waveform area. Peaks come in as a texture. The waveform
   is one line whose noise displacement follows the sample's amplitude, so loud passages move more. The shader
   draws its core and glow from the distance to the line, and a haze that the grains excite.
2. **Grains.** The plugin's status message (polled at 60 Hz) carries the active grains: position, size, amplitude,
   pitch, pan and depth. The shader brightens and agitates the waveform where grains play, their 3D depth shows
   as blur and size.
3. **Overlays,** drawn in the same shader: position and spray range, scan direction, and the drop state (dimmed
   waveform, glowing "DROP" label).
4. **Colour:** cyan. Other themes later at most, as a page setting saved with the state, not automatable.

## Page

1. Waveform on top (full width, about 96px), one row of parameters below (8 at a time), pages switched by small
   section labels: GRAIN, PITCH, FILTER, SPACE, AMP, MOD.
2. A parameter is a small label, a large number and a row of nine dots for the value (Numeral, chosen in phase
   0), a modulated parameter shows its live value as a dot in the source colour. Drag vertically, Shift for fine,
   double-click resets, mouse wheel steps. Every control reports `clap.param-hovered`, drags ignore
   ctrl+click.
3. Typography: one small sans, upper case labels, tabular figures, colour only for state and modulation.

## Phases

0. **Design previews.** Static HTML pages with the WebGL waveform (fake grains, a dropped file works), several
   waveform styles and control styles at 512 x 176, to discuss and pick one.
1. **Engine core** in C++: grain pool, scheduler, sample playback, envelopes, pitch, reverse. Node tests against
   the bridge (like `wclap-bridge.test.ts`): rendered output, grain counts, state round trip.
2. **Filter and 3D** per grain, voices, ADSR. Tests for the spatial cues (ITD sign, ILD) and filter response.
3. **Sample transfer:** page decode, chunked upload, state with the sample, peaks back to the page. Tests for the
   chunk protocol and state size.
4. **Waveform view:** the chosen WebGL design wired to real peaks and the grain status.
5. **Controls and pages,** param-hovered, device-panel extension, window size.
6. **Modulation:** sources, routings in the state, assignment in the page.
7. **Polish and publishing:** README, license, `opendaw-commons/wclaps/xenon/`.

## Publishing

1. **Home:** opendaw-commons, so the bundle is in the studio's catalogue.
2. **Where it goes, known without loading it.** The commons build describes every bundle and writes each plugin's
   descriptor features into `index.json` (`WclapIndexPlugin.features`). They hold the kind (`instrument`,
   `audio-effect`) and `opendaw:device-panel`, so the studio can filter by both before it loads a bundle. No
   meta.json field is needed: the features come from the module itself and cannot disagree with it.

## Open

1. **Name.** Xenon: no synth plugin of that name found (2026-10-26), an iOS groove app (iceGear XENON) exists.
   A trademark search (EUIPO, USPTO, class 9) before publishing.
2. **Presets.**

## Status (2026-10-26)

Phases 0 to 7 built in `opendaw-commons/wclaps/xenon/` (uncommitted): the engine (`source/plugin/xenon.cpp`), the
page (`source/page/index.html`), README and meta.json, the commons validator builds it. openDAW tests it against
the module in `packages/studio/core-wasm/test/assets/xenon.wasm` (`wclap-bridge.test.ts`, 15 tests: panel and
window sizes, parameters, upload and peaks, grains while a note is held, the 128 grain pool, azimuth, centre,
filter, key tracking, state round trip with sample and modulation, clear, oversized uploads, page edits). 128
grains with motion and filters render at about 10 times realtime.

Not done: presets, a check in the studio (the page was only rendered headless with simulated plugin messages).
