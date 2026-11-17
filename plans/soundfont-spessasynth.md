# Soundfonts read by spessasynth_core

Issue #464: `HD_Percussion.sf2` (Polyphone, empty INAM) is refused by the `soundfont2` package (0.5.0, falsy name
check). `spessasynth_core` 4.4.10 (Apache-2.0, active) reads it: 1 preset, 31 samples, and writes SF2 back. We take
the full package (116 KB gzip, loaded on demand like today), a fork comes later only if size matters.

## What changes (done 2026-11-17, next-release)

1. One module in studio-adapters, `SoundfontBank`, the only place that touches `spessasynth_core`: load from bytes,
   preset list (bank, program, name), per preset its zones with their instrument zones (global zones are not applied, as
   before), each with its generators as a record by SF2 generator id and its sample (Int16 PCM, rate, loop, root
   key, pitch correction). Everything else in openDAW reads only this shape, never the library.
2. `ExternalLib.SoundFont2` becomes `ExternalLib.Soundfont`, a reader built on the dynamic import of `spessasynth_core`.
3. Callers move to `SoundfontBank`:
   1. studio-core: `SoundfontService` (import, name from the bank or the file name when empty),
      `DefaultSoundfontLoader` (two load paths), `EngineWorklet`, `OfflineEngineRenderer`.
   2. studio-adapters: `SoundfontLoader`, `SoundfontFileBoxAdapter`, `SoundfontDeviceBoxAdapter` (preset list),
      `protocols.ts` (`fetchSoundfont` type).
   3. core-wasm: `soundfont-simplify.ts` (the engine blob), `processor.ts`, `offline-worker.ts`.
   4. studio: `SoundfontDeviceEditor` (names, preset menu).
   5. next-release only: `SamplerSoundfont` (import), `SamplerImporter`, Sampler soundfont export.
4. Remove `soundfont2` from adapters and core-wasm `package.json`.

## Nothing must break

1. Parity test: for every soundfont we have (test-files, the default GM soundfont, the cloud ones we can fetch), the
   engine blob from `simplifySoundfont` is byte-identical between the old `soundfont2` path and `SoundfontBank`.
   Written BEFORE the move, kept until the old package is gone.
2. Preset lists (order, bank, program, name) identical for the same files.
3. `HD_Percussion.sf2` imports and plays (issue file as a test fixture if the licence allows, else a synthetic file
   with an empty INAM).
4. Existing core-wasm soundfont tests (playback, replace, simplify, tuning) stay green unchanged.

## Branches

1. ~~Decided: all of it on next-release (2026-11-17).~~

## Decided

1. ~~SF3 and DLS are accepted by the Soundfont import and the Sampler import.~~
2. The Sampler export keeps its own SF2 writer.
