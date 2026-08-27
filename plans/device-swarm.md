# swarm — polyphonic sampler instrument

A sampler instrument that maps ONE dropped sample across the keyboard: each note is a pitch-rate
read head over the sample (linear interpolation), transposed relative to a configurable **root key**
(the note that plays the sample at its native rate), with an attack/release envelope, a start/end
region, reverse playback and an octave shift. The reference device throughout is **Nano**
(`device-nano`), which swarm extends; the Playfield sample slot (`device-playfield-sample`)
informed the region and parameter patterns.

## Feature set

- Drag & drop (or browse) a sample onto the waveform display; peaks render with the selected
  region emphasised and the region boundaries draggable directly on the waveform.
- Polyphonic voice pool (64 voices), each voice a `2^((pitch - rootKey + cent/100)/12 + octave)`
  rate read head — playing the root key reproduces the sample at its native rate.
- Root key (C-2..G8, note-name knob), octave shift (±3), reverse playback, attack (1 ms..5 s) and
  release (1 ms..8 s) squared envelope, unit sample start/end region, output volume.
- Crossfade loop: a loop toggle, dedicated loop start/end points (unit positions, clamped inside the
  sample region, live-adjustable, green markers on the waveform) and a fade time (1 ms..1 s). The
  voice plays the sample lead-in, then cycles the loop range through an equal-gain linear crossfade,
  so a held note sustains perpetually; the release still decays it, and it mirrors under reverse.
- Live per-voice playhead lines painted over the waveform (a float broadcast at the box address
  + `[1001]`, mirroring the Playfield slot pattern).

## Structure

- `packages/studio/forge-boxes` … `SwarmDeviceBox` schema (field keys 10..27) → generated box +
  `registry.rs` entry.
- `packages/studio/adapters` … `SwarmDeviceBoxAdapter` (parameter mappings, note-name
  `StringMapping.indices` for the root key), `InstrumentFactories.Swarm`.
- `packages/app/studio` … `SwarmDeviceEditor` (waveform + region dragging + drop zone + knobs).
- `crates/stock-devices/device-swarm` … the DSP as a runtime-loadable WASM device (`lib.rs` the
  `Instrument` impl and ABI exports, `voice.rs` the pure-DSP voice with unit tests), registered in
  `build-wasm.sh` `DEVICE_CRATES` and `engine-modules.ts` `DEVICES`.

## Process

Built with AI assistance (Claude Code). The TypeScript processor came first (a Nano derivative,
verified interactively in the studio: drag & drop import, four-voice chords with divergent playhead
rates, forward/reverse playback, root-key unity-rate check). When upstream removed the TypeScript
device engine, the DSP was ported to `device-swarm` following the Nano port, and the port's unit
tests immediately caught a regression the interactive testing had missed (an end-of-sample clamp
that terminated reverse voices on their first frame — reverse starts AT the last frame). The clamp
now bounds the interpolation partner instead, and a dedicated test covers a sample swapped mid-note
to a shorter one.

## Not in this iteration

- Built-in FX (vibrato / filter / reverb / tone shift) were prototyped and removed again; effects
  compose behind the instrument in the audio-effect chain instead.
- No multi-zone key mapping — one sample, one zone.
