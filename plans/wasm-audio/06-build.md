# 06 — Build toolchain & integration

## Rust → wasm

- Target **`wasm32-unknown-unknown`** (browser worklet, no WASI). The engine crate and **each device
  crate** compile to their own `.wasm`.
- **No `wasm-bindgen` in the hot path** — we use a custom C-ABI + shared memory (`05`), not idiomatic
  JS bindings. A thin hand-written JS loader instantiates modules and wires `Memory` + `Table`.
  (wasm-bindgen optional for non-hot-path glue only.)
- **`no_std`-leaning core** with a custom / arena allocator — fits the allocator model in `05`, keeps
  it deterministic.
- Target features: **SIMD128 on** (DSP). Shared-memory feature only if the engine memory must be
  `SharedArrayBuffer`-backed for cross-thread (asset/comms) zero-copy — flag, decide in `05`.
- **Pin the toolchain** (`rust-toolchain.toml`) for reproducible builds (matters: we trust builds +
  tests, not code review).

## Layout & outputs

- `crates/` cargo workspace builds the engine + N device crates → one `.wasm` each (+ a manifest).
- Size: `opt-level = "z"`, `lto`, **`wasm-opt`** (binaryen), strip. Matters with many device wasms.
- Output lands in a thin **TS wrapper package**; vite serves the `.wasm`; the worklet `fetch` +
  instantiates it.

## Monorepo integration

- An npm script runs `cargo build --release` (wasm) + `wasm-opt`, emitting into the TS wrapper.
  Hooked as a `predev` / `prebuild` step.
- Dev loop: `cargo-watch` rebuilds on change → vite reload / HMR.
- **Prebuilt artifact:** commit (or CI-cache) the built `.wasm` so **TS-only contributors run the app
  without Rust installed**; the cargo build runs only when the engine changes.
- Cross-origin isolation (COOP/COEP) for `SharedArrayBuffer` is **already required** by the studio —
  no new server config.

## CI

- Install pinned Rust + `wasm32-unknown-unknown` + wasm-opt; cache `~/.cargo` + `target/`.
- `cargo test` (**native**, fast) every commit — the bulk of unit + parity.
- Build wasm + run a **wasm parity subset** (headless runner); full wasm parity nightly.

## Test build targets

- **native** (`cargo test`) — dev loop + CI speed.
- **in-wasm** — headless runner (wasm-bindgen-test / node + offline render) for fidelity (the shipping
  artifact).

## Size investigation (binary size, why `engine.wasm` is large)

Reference point that prompted this: the TS studio ships a **193 KB** JS bundle that contains **all**
devices, yet `engine.wasm` **alone, with no device plugins**, is **208 KB**. That looks wrong at first
glance. It is partly a misleading comparison and partly real, addressable bloat. Both halves below.

### Measured (release `engine.wasm`, 2026-06-23)

- raw **208,279 B** · gzip-9 **73,576 B** · brotli-11 **58,975 B**.
- Code section is **97.9 %** of the file (203 KB of 208 KB); the Data section is only ~3 KB. So this is
  **code size**, not embedded data/strings.
- **654 functions.** Attributing code bytes to symbols (rebuild with `strip=false`, parse the
  disassembly):
  - `studio_boxes::registry::registry` — **23,316 B in one function (11 % of the whole module).**
    The single biggest item by far.
  - `alloc::collections::btree::*` + `core::slice::sort` (BTreeMap/BTreeSet `insert` / `From<[(K,V);N]>`
    / quicksort / drift-sort) — **~41 KB**, spread across dozens of monomorphised copies (e.g. ~12
    near-identical 1,091 B `BTreeMap::From` instances, one per distinct `(K,V)`/array length).
  - `engine::*` real logic (`reconcile_units`, `observe_params`, `teardown_wired`, `apply_updates`,
    `render`, `bind`) — **~34 KB**. Legitimate.
  - `boxgraph::*` (`rebuild_edges`, `read_fields`, `read_value`) — **~18 KB**. Legitimate.
  - `libm::powf` ~2.1 KB; `talc` allocator ~1.6 KB.
- **It is NOT fmt/panic bloat.** `panic=abort` is set; total panic code is ~36 B and float-formatting
  is ~2.4 KB. The release profile (`opt-level="z"`, `lto`, `panic="abort"`, `strip`) is already correct.

### Why the 193 KB-vs-208 KB headline is not apples-to-apples

- **JS shares the V8 runtime; wasm ships its own.** The 193 KB TS bundle is *minified source* that
  leans on the engine the browser already has: its allocator, its `Map`/`Set`/sort, string and number
  formatting are all free. `engine.wasm` must **statically link** its own allocator (`talc`), its own
  B-tree/sort/collection implementations, `libm` (`powf`, …), and string machinery. That is a fixed
  floor JS never pays.
- **Compare compressed-to-compressed.** The server serves compressed; `engine.wasm` is **59 KB brotli
  / 74 KB gzip**. The 193 KB TS figure is the uncompressed bundle. Like-for-like the gap is much
  smaller than the raw headline implies. Track gzip/brotli, not raw, as the real metric.

### Real, addressable bloat (the levers, in priority order)

1. **`wasm-opt` is wired but not running here.** `build-wasm.sh` runs `wasm-opt -Oz` *only if binaryen
   is installed* — it is **not** on this machine, so the shipped module is **un-optimised by binaryen**
   (`public/engine.wasm` is byte-identical to the raw cargo output). `brew install binaryen` and expect
   roughly **10–20 %** off for free. Lowest-effort win; do this first and re-measure before anything else.
2. **`studio_boxes::registry()` — the 23 KB generated builder.** It is `@generated` imperative
   construction: ~80 `Registry::from([... ("Name".to_string(), Schema::from([...nested Object/Array...]))
   ...])` entries, each `.to_string()` heap-allocating and each `Schema::from([...])` a fresh
   array→BTreeMap construction the compiler inlines and monomorphises. This one function also **bakes
   every device's box schema into the engine** (e.g. `VaporisateurDeviceBox`, `TidalDeviceBox`, …) even
   though those devices ship as **separate `.wasm` plugins** — the engine carries schema for boxes it may
   never read. Options: (a) emit the registry as a **compact static data blob** (bytes / PHF) the engine
   parses once into the `Registry`, instead of hundreds of inlined constructor calls; (b) **register only
   the box types the engine itself reads**, and let device plugins contribute their own schema at load.
   This is also the root cause of much of lever 3.
3. **Generic-collection monomorphisation explosion (~41 KB).** Every distinct `(K,V)` and every distinct
   array length spawns its own `BTreeMap`/`BTreeSet` `From`/`insert`/sort copy; the registry's nested
   `Object` schemas multiply them. Reduce the number of **distinct** map/set instantiations (share one
   key/value representation and one comparator, or use a flat sorted `Vec` for the small static maps) so
   LTO can collapse them.

Targets to set once levers 1–2 land: re-measure raw **and** brotli, and decide an acceptable engine
floor knowing ~50 KB of it (allocator + collections + libm) is the unavoidable static-runtime cost JS
externalises. See the matching open question in `open-questions.md`.

## Open

- wasm test runner choice (wasm-bindgen-test vs custom node harness).
- Whether engine memory must be SAB-backed (→ shared-memory build features) — settle in `05` / spike.
- Device-package bundling (wasm + UI + manifest) for runtime-loaded plugins.
