# Mid/Side Split (issue #90)

A fourth audio effect composite next to FX Composite, Stereo Split and Frequency Split. Two fixed entries: entry 0
processes the mid, entry 1 the side, each on its own effect chain, summed back. Answers #90 (Mid-Side EQ): a Revamp
in the Mid entry sees and shows only the mid, one in the Side entry only the side, prelisten is the entry solo.

## Decisions (2026-11-20)

1. Plain M/S matrix, no FFT centre extraction (ever). It is lossless and what every pro M/S tool uses.
2. Branches stay in the L/R domain, so the existing wet sum decodes and no new node is needed:
    1. Mid entry reads `(M, M)` with `M = (L + R) * 0.5`
    2. Side entry reads `(S, -S)` with `S = (L - R) * 0.5`
    3. Sum: `(M + S, M - S) = (L, R)`
3. Scaling 0.5: a soloed Mid plays the mono sum at its real level, a soloed Side the real side level.
4. An untouched split reconstructs within float rounding (about -150 dB), not bit identical like Stereo Split.
5. Stereo effects inside a branch keep their stereo output (a reverb on Mid adds side, a widener on Side adds mid).
   That is intended, the branches are not collapsed to mono.
6. Branch latency differences are aligned by the wet sum's junction delays (PDC), already in place.
7. Name "Mid/Side Split", box `MidSideCompositeBox`, same field keys as `StereoCompositeBox`.

## ~~Phase 1: Engine~~

1. `DistributorMode::MidSide` in `crates/engine-env/src/composite_mix.rs`: two branch buffers like Stereo, filled
   with `(M, M)` and `(S, -S)`. An entry index beyond 1 reads silence.
2. `Distributor::MidSide = 3` in `crates/engine/src/lib.rs` (WASM contract), mapped in
   `crates/engine/src/effect_composite.rs`.
3. Tests in `crates/engine-env/tests/composite_mix.rs`:
    1. empty split reconstructs L/R within 1e-7 for noise, mono, hard left, hard right, anti phase and full scale
    2. Mid and Side values for a fixed L/R pair
    3. Mid branch of a mono signal is the signal, Side branch is zero
    4. Side branch of an anti phase signal is the signal, Mid branch is zero
    5. stray third entry stays silent
4. Tests in `crates/engine/src/audio_unit/tests.rs` through a real composite: untouched passes the input, muted
   Side leaves `(M, M)`, soloed Side plays `(S, -S)`.

## ~~Phase 2: Schema, adapter, factory~~

1. `packages/studio/forge-boxes/src/schema/devices/audio-effects/MidSideCompositeBox.ts` (copy of Stereo's fields)
   and its entry in `schema/devices/index.ts`, regenerate `packages/studio/boxes` and
   `crates/studio-boxes/src/registry.rs`.
2. `EffectCompositeDistributor.MidSide = 3` and the spec in `packages/studio/core-wasm/src/engine-modules.ts`.
3. `MidSideCompositeBoxAdapter` in `packages/studio/adapters`, `BoxAdapters.ts`, `index.ts`,
   `AudioCompositeAdapter.ts`, `DeviceManualUrls.MidSideComposite`.
4. `EffectFactories.MidSideComposite` (two fixed entries labelled Mid and Side), `AudioNamed` after Stereo Split,
   `EffectBox.ts`. New `IconSymbol.MidSideSplit` (a circle between two arcs).
5. Tests next to the Stereo ones: `EffectFactories.test.ts`, `CompositeAdapters.test.ts`,
   `PresetEncoder.composite.test.ts`, `core-wasm/test/composite-audio.test.ts` (renders the reconstruction).
6. `core-wasm/test/delay-compensation.test.ts`: a look-ahead Compressor on the Side entry only, empty Mid, a
   single impulse comes out once, delayed by the look-ahead (PDC aligns the branches). Needs the real box and a
   latent device, which the engine's stub devices cannot give.

## ~~Phase 3: UI, scripting, manual~~

1. `DeviceEditorFactory.tsx`: `visitMidSideCompositeBox` with the fixed entry editor Stereo Split uses, entries
   named Mid and Side.
2. `DeviceTags.ts`: `["stereo", "routing"]`.
3. Scripting: `AudioEffects.ts`, `DeviceBoxes.ts`, `Api.ts`, `api.declaration.d.ts`, `Devices.test.ts`,
   `Parity.test.ts`.
4. Manual `packages/app/manual/public/devices/audio/mid-side-composite.md` with a screenshot: what mid and side
   are, the low end mono use case from #90, solo as prelisten, why a stereo effect in one branch reaches the other.
5. Browser check on DEV build: Revamp in Side on a wide mix, low cut, solo Side, solo Mid, bypass comparison.
