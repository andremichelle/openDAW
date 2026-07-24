# Update NAM to Architecture 2 (A2)

Reference: https://www.tone3000.com/blog/introducing-neural-amp-modeler-nam-architecture-2-a2
Guide: https://tone3000.com/guides/nam-a2-the-complete-guide

## TL;DR

- **Multi-instance: nothing to do.** Multi-instance support is already implemented and shipped. The only WASM change needed for A2 is **bumping the vendored NeuralAmpModelerCore from 0.3.0 to >= 0.5.3 and rebuilding**. The existing multi-instance C wrapper stays as-is.
- A2 is a new architecture, **not** a drop-in update, but it loads through the **same `nam::get_dsp(json)` entry point**. A1 models keep working. Once the core is updated, A2 `.nam` files load with **zero openDAW code changes** required for playback.
- Everything else (TS model types, properties dialog, tone3000 browser) is **cosmetic/optional** polish, not required for A2 audio to work.

## 1. Multi-instance question (answered)

The old `plans/nam-integration.md` describes a "single global model" limitation:

```cpp
std::unique_ptr<nam::DSP> currentModel;  // single instance
```

**That limitation no longer exists.** It was solved when `@opendaw/nam-wasm` was built. The shipped package (`@opendaw/nam-wasm@1.1.0`, repo `andremichelle/nam-wasm`) already provides a multi-instance C API:

- `wasm/nam-multi-instance.cpp` holds `std::map<int, std::unique_ptr<nam::DSP>> instances` with `nam_createInstance` / `nam_destroyInstance` / per-instance `nam_loadModel` / `nam_process` / `nam_reset`.
- `NeuralAmpDeviceProcessor` already uses this: one instance per device for mono, a second instance for stereo (`#instances: [int, int]`), each device independent.

**Conclusion: no multi-instance WASM work is needed for A2.** The instance model is orthogonal to the architecture and keeps working after the core bump.

## 2. What A2 actually is (relevant facts)

- A2 keeps the WaveNet family shape (dilated causal convolutions, residual + skip connections) but rebuilds it: **LeakyReLU** instead of Tanh, a **convolutional head** (window mixer) instead of a per-sample waveshaper, **mixed kernel sizes** in a single layer array, hand-tuned non-doubling dilation schedule, larger receptive field (~6,350 samples vs ~4,100).
- 30-40% less CPU than A1-Standard at higher quality. Packed/slimmable training ships multiple sizes (A2-Full ~8ch, A2-Lite ~3ch) in one model.
- Training data normalized to **-18 dBu / -18 dB RMS reference** (the processor's loudness compensation target already aligns with this).
- **Inference**: handled inside NeuralAmpModelerCore. A2 support landed in `sdatkinson/NeuralAmpModelerCore` (latest **v0.5.3**, June 2026; includes `generate_weights_a2.py`). Loading remains via `get_dsp(json)`, dispatched by the `architecture` string. No new public DSP API is needed by the wrapper.
- Optional CMake fast path `NAM_ENABLE_A2_FAST` (unrolled 1x1 conv matmuls) exists upstream for extra performance.

## 3. Current state in our tree

WASM source repo: `/Users/am/Repositories/andre.michelle/nam-wasm` (published as `@opendaw/nam-wasm`).

- `NAM/version.h` => DSP version **0.3.0** (vendored copy of NeuralAmpModelerCore, committed directly into the repo, **not** a git submodule; only `Dependencies/eigen` is a submodule).
- `NAM/get_dsp.cpp` dispatches `architecture` in {`Linear`, `ConvNet`, `LSTM`, `WaveNet`} — i.e. **pre-A2**. A current A2 `.nam` will fail to load (or silently bypass) on this core.
- `wasm/nam-multi-instance.cpp`, `wasm/CMakeLists.txt`, `wasm/build-nam.bash` — multi-instance wrapper + Emscripten build, unchanged by A2.

openDAW consumers (both pin `^1.1.0`):
- `packages/studio/core/package.json`
- `packages/app/nam-test/package.json`
- Runtime: `packages/studio/core-processors/src/devices/audio-effects/NeuralAmpDeviceProcessor.ts` (passes raw model JSON string straight to `wasm.loadModel`).
- TS model types: `node_modules/@opendaw/nam-wasm/dist/NamModel.d.ts` (source in the nam-wasm repo `src/`).
- UI: `NeuralAmp/NamModelDialog.tsx`, `ArchitectureCanvas`, `NamTone3000.ts`, `NamLocal.ts`.

## 4. Work in the `nam-wasm` repo (the real work)

### 4.1 Update the vendored NeuralAmpModelerCore (required)
1. Replace the `NAM/` directory with NeuralAmpModelerCore **>= 0.5.3** (the version carrying A2 + `generate_weights_a2.py`). Keep the same vendoring approach (copied into the repo, not a submodule), or convert it to a pinned submodule for easier future bumps — decide and note it.
2. Confirm `Dependencies/nlohmann` and `Dependencies/eigen` versions satisfy the new core (the new core may require a newer Eigen / json). `wasm/CMakeLists.txt` already includes both include dirs.
3. Verify the wrapper still compiles against the new core API. The wrapper relies on:
   - `nam::get_dsp(const char*)` returning `std::unique_ptr<nam::DSP>`
   - `DSP::Reset(sampleRate, maxBufferSize)`, `DSP::prewarm()`, `DSP::process(float*, float*, int)`
   - `DSP::HasLoudness()`, `DSP::GetLoudness()`
   - `nam::activations::Activation::enable_fast_tanh()`
   These are stable across 0.3 -> 0.5, but **must be re-checked** — if any signature changed (e.g. `prewarm` overloads, `Reset` args, a renamed loudness accessor), adjust `nam-multi-instance.cpp` minimally.
4. Make sure A2's `architecture` string is handled by the new `get_dsp.cpp` dispatch (it is, since we ship the upstream core that introduced A2). No wrapper-side dispatch logic to add.

### 4.2 Optional: enable the A2 fast path
- If upstream exposes `NAM_ENABLE_A2_FAST`, add `add_definitions(-DNAM_ENABLE_A2_FAST)` (or the documented CMake option) in `wasm/CMakeLists.txt` and measure WASM size + CPU. Treat as a follow-up; default off until benchmarked.

### 4.3 Update the TS model types (cosmetic, for the properties dialog)
- In `src/NamModel.ts` / `NamModel.d.ts`, A2 configs may have **per-layer/mixed kernel sizes** and a `LeakyReLU` activation, and the head may be convolutional rather than per-sample. Today `NamModelLayerConfig` assumes a single `kernel_size: number`. This only affects the **Properties dialog** display (layer count, `ArchitectureCanvas`), never audio. Relax the types so A2 configs parse without throwing in `NamModel.parse`, and keep unknown fields optional.

### 4.4 Build, version, publish
1. `npm run build` (runs `wasm/build-nam.bash` via emscripten, then `tsc`). Requires the emscripten toolchain.
2. Sanity-check `dist/nam.wasm` size (current 209 KB; A2 core may grow it — confirm it still Brotli-compresses reasonably).
3. Bump `@opendaw/nam-wasm` to **1.2.0** (architecture support change, backward compatible API). Update README/attribution to note A2 + the new core version.
4. `npm publish`.

## 5. Work in the openDAW repo

### 5.1 Required
1. Bump the dependency to `^1.2.0` in:
   - `packages/studio/core/package.json`
   - `packages/app/nam-test/package.json`
   - Update `package-lock.json` (`npm install`).
2. Confirm the build still copies `nam.wasm` into the SDK dist and that `EngineWorklet` / `OfflineEngineRenderer` fetch the new binary (no path change expected).
3. **Type-check only** with `tsc --noEmit` across `studio-core`, `core-processors`, adapters, and the studio app — the wrapper TS API (`NamWasmModule`, `createNamModule`, `NamModel`) is unchanged, so this should pass cleanly.
4. No change needed in `NeuralAmpDeviceProcessor.ts`: it forwards the raw JSON to `loadModel`, so A2 models load automatically once the core understands them.

### 5.2 Optional polish
- **tone3000 browser** (`NamTone3000.ts`): the tone3000 API still defaults to A1; A2 must be explicitly requested. Decide whether to surface A2 packs (e.g. an arch filter / badge) and whether `pickDefaultModel` should understand A2 size labels (`full`/`lite`) in addition to the current `standard` lookup, which currently falls back to `models[0]` for A2 packs.
- **Properties dialog** (`NamModelDialog.tsx` + `ArchitectureCanvas`): show an A2 vs A1 badge and render mixed-kernel A2 layers correctly. Cosmetic.
- **Performance headroom**: A2 is cheaper; revisit any documented instance-count guidance.

## 6. Verification

1. nam-wasm: build, then load both an **A1** and an **A2** `.nam` (use `example_models/` + a fresh A2 download from tone3000) through `nam_loadModel` and process a short buffer — confirm A2 returns non-bypass audio and `nam_getInstanceCount` behaves with multiple instances.
2. openDAW: in the studio app, add a Neural Amp device, load an A2 model from local file and from tone3000, confirm audio, mono and stereo paths, transport stop (`reset`), and the Properties dialog open without errors.
3. Regression: confirm existing projects referencing A1 models still load and sound identical (migration in `MigrateNeuralAmpDeviceBox.ts` is unaffected — it only moves JSON between fields).
4. Offline render parity via `OfflineEngineRenderer`.

## 7. Risks / open questions

- **Core API drift 0.3 -> 0.5**: small chance a wrapper signature needs adjusting (Section 4.1.3). Low effort, caught at compile time.
- **Eigen/json version bump** for the new core could change WASM size or require updating `Dependencies/`.
- **Emscripten toolchain** must be installed locally to rebuild the WASM (build happens in the separate `nam-wasm` repo, not in openDAW CI).
- **A2 `architecture` string**: verified handled by upstream core; if upstream uses a distinct string and dispatch differs, that is already inside the vendored `get_dsp.cpp` we ship — no extra work, but confirm during 4.1.
- **`.namb` binary format** (embedded) is out of scope; openDAW stays on JSON `.nam`.

## 8. Order of execution

1. nam-wasm: bump core to >= 0.5.3, recompile wrapper, fix any signature drift (4.1).
2. nam-wasm: relax TS types for A2 (4.3), optional A2 fast path (4.2).
3. nam-wasm: build, bump to 1.2.0, publish (4.4).
4. openDAW: bump dep, `npm install`, type-check, smoke test (5.1).
5. openDAW: optional tone3000 / dialog polish (5.2).
6. Verify A1 + A2, mono + stereo, offline (Section 6).
