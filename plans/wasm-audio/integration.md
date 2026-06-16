# Integration — a separate WASM test app

## Decision

A fresh app at **`packages/app/wasm/`** (sibling to `packages/app/studio/`) hosts the new engine and
its tests — its own entry point, vite config, and **as many test sub-pages as we want** (sine,
composition spike, project playback, A/B vs TS, telemetry, per-feature tests). **The studio app is
untouched** — not even a Router change.

## Why a separate app (vs a `/wasm` route in the studio)

- Zero coupling/intrusion to the studio; total freedom to add test sub-pages.
- Still reuses the real infra — project/box-graph loading, asset delivery (`fetchAudio`→`AudioData`),
  peaks, protocols — because that lives in shared **packages** (`studio-core`, `studio-adapters`,
  `studio-boxes`, `lib-dsp`, `lib-fusion`), which any app imports. We get the data/asset layer
  **without** the studio UI.
- Wires only what a test needs (a minimal worklet host), not the whole `StudioService`.

## Pieces

- `crates/audio-engine` (Rust) → built `.wasm` → a thin **`wasm-engine` wrapper package** (loader),
  kept separate so the studio reuses the same loader later (no duplication).
- `packages/app/wasm/` imports that wrapper + the shared packages; hosts its own AudioWorklet running
  the new engine.
- Its dev server sets **COOP/COEP** (SharedArrayBuffer).

## Phasing (communication plan)

1. **Load + play** a read-only project box-graph snapshot. No live edits.
2. **Back-channel** telemetry — peaks, spectrum, position → page (DSP→UI contract, `device-contract.md`).
3. **Live box-change sync** — one-way (`04`). Last, because it's the hardest.

## Implemented (step 1)

- JSX **Router** app (`@opendaw/lib-jsx`): `src/App.tsx` (Router + `LocalLink` nav), pages under
  `src/pages/` (`HomePage`, `SinePage`), mounted in `main.tsx`. New test = new `*.tsx` + a route.
- Deploy: `deploy/wasm.ts` (SFTP `dist/` → `/wasm.opendaw.studio` + SPA-fallback `.htaccess`,
  **no CORS/COOP yet**) and `.github/workflows/deploy-wasm.yml` (`workflow_dispatch`, installs Rust,
  builds, deploys) — independent of the studio's `deploy.yml`.

## Notes

- Test projects = the `07` fixtures (shared corpus).
- Complements the offline CI parity harness (`07`): offline = automated contract; this app =
  interactive A/B vs TS, meters/spectrum, live null-test residual.
- Dev vehicle **before** the rollout flag (`09`); the studio engine swap happens later via the flag,
  not here.
