# Tubular (Dexed / DX7 port into openDAW)

**Status 2026-09-25 (evening)**: phases 1 to 3 committed (017593cc9). Device name **Tubular** ("DX7" is a
Yamaha trademark and "Dexed" is Pascal Gauthier's, both only mentioned descriptively).

- Engine `crates/stock-devices/device-tubular`: Rust port of Dexed's msfa + host layer + output filter.
  Parity: 1205 cases sample-exact against Dexed's engine (fixtures generated once from a C++ harness at Dexed commit 2e182b3d, harness not in the repo; every bundled
  cartridge voice + 21 host edge cases), the float output filter within 1e-6. `cargo test --release`.
- Schema `TubularDeviceBox` (156 automatable params), adapter, factory, scripting facade, editor v1
  (cartridge menu, voice prev/next, credits, Load .syx…), 37 bundled cartridges in
  `packages/app/studio/public/tubular/` with `index.json` credits. Browser-verified: plays, meter moves.
- Audition tool (uncommitted): cartridge menu → "Audition cartridges…": arrows step voices / banks,
  space plays a phrase, K keeps; keepers persist in localStorage; "Save keepers as presets" writes each
  voice as a Tubular instrument preset (user storage, credits in the description), "Upload keepers as
  stock" appears with an access key, "Export list" downloads the keeper JSON. Licence research: no
  redistributable pack beyond Dexed's built-ins + YM2612 exists (Legowelt and Soundplantage need the
  authors' permission), so curation from the 1184 bundled voices is the way.
- Mark I engine ported (uncommitted): Dexed's default kernel, incl. its dedicated feedback chains for
  algorithms 4, 6 and 32; sample-exact against the real Dexed 1.0.1 VST3 (hosted headless via pedalboard)
  and the oracle (1232 fixture cases: all voices Mark I, edge cases in both engines). Plain `engine`
  field (0 Mark I default, 1 Modern), switch in the device menu.
- Tubular Classics (uncommitted): `packages/studio/adapters/scripts/tubular-classics.mts` writes 32 original voices
  (3 EPs, 6 bells/mallets, 4 basses, 6 brass/strings/winds, 6 keys/organs/plucks, 4 leads, 3 drums) into
  `public/tubular/cartridges/Tubular_Classics.syx` + index entry (CC0, first in the menu). Rate scale
  measured on the engine: R3 30/40/50/60/70 = 8.5/3/0.9/0.3/0.12 s to -60 dB, attack R30/40/50/60 =
  1.5/0.5/0.17/0.05 s. First pass by numbers, needs his ear; iterate in the script and rerun it.
- Open: phase 4 full editor, sysex export. Deviation from Dexed: loading a voice does not
  cut sounding notes (Dexed panics), events snap to the 64-sample frame like the plugin.

## Sources evaluated

| Source | Licence | What it is | Verdict |
|---|---|---|---|
| asb2m10/dexed `Source/msfa` | Apache-2.0 | Google music-synthesizer-for-android engine with Dexed's fixes (Sentinel77). ~1.7k lines C++: `fm_core` (32 algorithms), `fm_op_kernel`, `env`, `pitchenv`, `lfo`, `dx7note`, `sin`/`exp2`/`freqlut` tables, `porta`, `controllers.h` | THE engine to port |
| asb2m10/dexed `EngineMkI.cpp` / `EngineOpl.cpp` | GPL-3.0 | Alternate op kernels. Mark I = 12-bit log-sin/exp tables like the hardware, Dexed's default since 0.9.2, correct feedback on algo 4/6 | optional later phase (GPL-3.0 is AGPL-3.0 compatible) |
| asb2m10/dexed `PluginData.cpp`, `PluginProcessor.cpp` | GPL-3.0 | sysex pack/unpack, voice allocation, controllers, JUCE glue | reference for structure only |
| dcoredump/Synth_Dexed (codeberg, mirror probonopd/Synth_Dexed) | GPL-3.0 | Dexed engine without JUCE: one `dexed.cpp` host wrapper (voice pool, sysex decode, controllers, mono/porta) over msfa. Used by MiniDexed, MicroDexed, picodexed | cleanest reference for the host layer, and the native parity oracle |
| probonopd/MiniDexed | GPL-3.0 | bare-metal Raspberry Pi host around Synth_Dexed (8 instances, performances, fx) | nothing engine-wise beyond Synth_Dexed |
| risicle/dexed `ris-highway` | GPL-3.0 | Google Highway SIMD kernels | native concern, no gain for wasm |
| webaudiomodules/webdx7 | MIT (msfa Apache-2.0) | the OLD Google msfa tree compiled with emscripten into an AudioWorklet (2022) | proves msfa runs unchanged in wasm, second oracle |

Decision: hand-port Dexed's `Source/msfa` to Rust (keep the Apache notice in `licenses/`). All stock
devices are Rust cdylibs behind `abi` (no `cc`/`cxx` precedent in `crates/`), and msfa is integer
fixed-point over lookup tables, so a bit-exact port is testable. Host layer modelled on Synth_Dexed's
`dexed.cpp` (structure, not text). Mark I engine and OPL are out of v1.

## Cartridges (presets)

Format: DX7 32-voice bulk dump, 4104 bytes = `F0 43 0n 09 20 00` + 4096 packed bytes (128 per voice)
+ checksum + `F7`. Dexed also accepts the headerless 4096-byte body and sysex streams. Single voice
(VCED) = 163 bytes. Unpacked voice = 155 parameters + 10-char name.

Licence-cleared candidates:

1. Dexed `assets/builtin_pgm.zip`: 33 cartridges (`Dexed_01`, `SynprezFM_01..32`), compiled by
   Jean-Marc Desprez, patches by the authors credited in Dexed's README, shipped inside a GPL-3.0 repo.
   Include with credits.
2. NickCulbertson/YM2612-Dexed-Presets: 4 cartridges (Genesis instruments), MIT. Include.
3. Banana71/Soundplantage (MiniDexed performances): licence to check before use.
4. Excluded: Yamaha ROM1A..4B and VRC cartridges (Dexed_cart_1.0.zip, Bobby Blues, Caskexe/DX which
   claims Unlicense over Yamaha factory data). Users load those themselves via Load .syx.

Hosting: `assets.opendaw.studio/dx7/index.json` + one file per cartridge, entries
`{uuid, name, author, license, source, size}`, a `OpenDx7CartridgeAPI` mirroring `OpenSoundfontAPI`
(memoized index, retry, no-cache). A loaded voice is written into the box fields (lossless, like
Neon), so projects never depend on the catalogue staying online. The cartridge is a browse source only.

## Phases

### 1. Engine crate

`crates/stock-devices/device-tubular`, `Instrument` template like device-neon.
Port module by module with the msfa tests moved over case by case: `sin`, `exp2`, `freqlut`,
`fm_op_kernel` (plain + feedback), `fm_core` (32 algorithms table), `env` (rates, levels, rate
scaling, the `qrate` staircase), `pitchenv`, `lfo` (6 waves, delay, sync), `dx7note` (op frequency,
key scaling breakpoint curves, velocity, amp mod), `porta`, controllers (mod wheel, foot, breath,
aftertouch, bend). 16 voices, oldest-steal, mono mode + portamento like Synth_Dexed.

Parity harness: `examples/render.rs` renders voice N of a `.syx` for a fixed note list at 44100;
the oracle is Synth_Dexed built natively (or webdx7's wasm in node) rendering the same input. Tests
compare sample-exact (int32 kernel), floats only after Dexed's output filter/gain.

### 2. Schema, adapter, registration

`packages/studio/forge-boxes/src/schema/devices/instruments/TubularDeviceBox.ts` via
`DeviceFactory.createInstrument`. ALL 156 parameters the Dexed VST exposes are automatable
(`ParameterPointerRules`, verified against `Source/PluginParam.cpp`):

- `operators` array 6 × object, 22 each (132): EG rate 1-4, EG level 1-4, output level, mode
  (ratio/fixed), coarse, fine, detune, break point, L/R scale depth, L/R key scale (curve), rate
  scaling, A mod sens, key velocity, switch (on/off).
- `pitchEnvelope` object (8): rate 1-4, level 1-4.
- globals (16): cutoff, resonance, output, mono mode, master tune, algorithm 1-32, feedback 0-7,
  osc key sync, LFO speed/delay/PM depth/AM depth/key sync/wave, transpose, pitch mod sens.

Plain (not automatable, settings in Dexed too): bend range up/down, bend step, portamento, engine
type (later). Name = `label`. Int32 for selects/switches, float32 with the 0-99 hardware domain for
the rest (Neon's `czParameter` pattern), the DSP owns the hardware tables. Adapter `createParameter`
mappings are the wasm value contract. `InstrumentFactories.Tubular` defaults = the DX7 INIT VOICE.
Entry in `engine-modules.ts` `DEVICES`, regen boxes + `registry.rs`. 156 bindings means 156
`bind_parameter` calls in the crate, generate the operator block from a table.

### 3. Presets first (the milestone)

- `Dx7Sysex.ts` (+ test): decode bank/voice/stream, unpack 128 → 155, checksum, encode back for
  export. `TubularPreset.apply(box, voice)` inside one `editing.modify`.
- Editor v1 = preset row only: cartridge select, program 1-32 select with prev/next, Load .syx…,
  plus a level meter. Same shape as Neon's first editor.
- `OpenDx7CartridgeAPI` + the hosted index with the 37 cleared cartridges, browse entry in the
  resource browser (Soundfont precedent), licence + author shown per cartridge.
- Browser checkpoint: play every cartridge, compare a handful against Dexed by ear and against the
  oracle renders.

### 4. Full editor

Rebuilt on `mixins.ControlLayout`: six OPERATOR tabs (Neon's line-tab pattern) each with an EG
widget (4 rates / 4 levels, one component reused 7× incl. pitch EG), level, coarse/fine/detune,
keyboard scaling (breakpoint as note, L/R depth, L/R curve), rate scaling, AMS, KVS, mode/sync,
on/off. Global block: algorithm canvas (32 layouts, feedback path drawn), feedback, LFO strip,
pitch EG, transpose, cutoff/resonance, output, tune, mono/porta. Per-phase browser checkpoints.

### 5. Later

Mark I engine as an engine switch (GPL-3.0, AGPL-compatible), sysex export of the current bank,
MPE, microtuning (SCL/KBM via Surge tuning-library) all skipped for now.

## Decided

- Device name: Tubular (2026-09-25).
- Automation: all 156 VST parameters (2026-09-25).

## Open questions

- Hosted catalogue vs bundling the 150 KB of cartridges in the app.
- Ask Pascal Gauthier (asb2m10) for a nod before shipping, credits in the device info either way.
