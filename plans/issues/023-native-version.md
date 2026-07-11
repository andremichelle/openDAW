# Native Version (#23)

**Doability:** ⭐⭐⭐☆☆ (3/5) — not hard technically, but it is a strategic fork (PWA vs. native wrapper) that needs a maintainer decision before any code is written.
**Type:** feature
**Scope:** large

## What is asked
User wants a locally installable version of openDAW for Linux, for offline use and better audio performance than a browser tab gives. Implied acceptance criteria: launches without a browser chrome, works fully offline, and ideally gets closer to the metal for audio (lower latency / no browser power-saving throttling).

## Current behaviour / relevant code
openDAW today is a pure browser SPA (`packages/app/studio/`), requires COOP/COEP cross-origin isolation for `SharedArrayBuffer` + AudioWorklet (see `plans/pwa.md`), and stores all user data locally in OPFS already (works offline once loaded). There is no installable artifact today — the root `README.md` explicitly lists both approaches as open contributor asks:

```
1. Offline App — e.g. wrapping openDAW with Tauri for a native desktop experience
2. PWA — turning openDAW into a fully installable Progressive Web App with offline support
```

A full PWA plan already exists at `plans/pwa.md` (SW strategy, manifest, consent-gated update flow, offline degradation). No Tauri/Electron scaffolding exists anywhere in the repo (verified: no `tauri.conf.json`, no `electron` deps, no `src-tauri/`).

Audio engine is being ported to WASM (`plans/wasm-audio/README.md`, tracked separately as #261) which is the real lever for "better audio performance" — that is an engine change, not a packaging change, and applies equally to browser, PWA, and native-wrapper builds.

## Plan
This issue is really "pick a packaging strategy," not an implementation task. Two independent paths, not mutually exclusive:

1. **PWA (recommended first step, smallest incremental cost).** Execute `plans/pwa.md` as written: root-scoped service worker, runtime-cache only (no full precache, ~124MB dist is not appropriate to ship wholesale), `manifest.webmanifest` for installability, consent-gated update flow reusing the existing `build-info.json` poll (`packages/app/studio/src/boot.ts:149`). This alone satisfies "locally installable... for offline use" on Linux (and every other desktop OS) with no new toolchain. Does **not** improve audio performance beyond what the browser already gives — COOP/COEP + AudioWorklet + SAB is unchanged.

2. **Native wrapper (Tauri, preferred over Electron for bundle size and Rust affinity — the project already has a large Rust codebase in `crates/` for the WASM engine).** A Tauri shell around the same Vite build gives: a Linux `.deb`/AppImage, no browser chrome, and access to native APIs (e.g. direct file system instead of OPFS, potentially lower-latency native audio backend via a custom Tauri audio plugin instead of Web Audio/AudioWorklet — this is the only path that could meaningfully improve audio performance, but it means bypassing Web Audio entirely, a large separate effort not implied by this issue).
   - Minimal version: wrap the existing web build as-is in a Tauri webview. COOP/COEP headers must be replicated by Tauri's dev/prod server config (Tauro supports custom response headers) since the webview still needs `crossOriginIsolated` for the AudioWorklet/SAB path.
   - Investigate whether Tauri's WebView (WebKitGTK on Linux) supports AudioWorklet + SharedArrayBuffer at parity with Chromium — WebKitGTK has historically lagged on Web Audio features; this is a spike, not an assumption.

## Risks / open questions
1. **Maintainer decision required**: PWA and Tauri solve overlapping but distinct problems (installability vs. true native performance/filesystem access). Recommend shipping PWA first (cheap, reuses `plans/pwa.md`) and treating Tauri as a separate, larger follow-up issue once there is demonstrated demand for filesystem/native-audio access beyond OPFS.
2. **WebKitGTK parity risk** for Tauri on Linux — AudioWorklet/SAB support must be spiked before committing.
3. **"Better audio performance"** is likely actually addressed by the WASM engine effort (#261), not by packaging. Worth clarifying with the reporter whether they mean install/offline UX or literal DSP throughput — the answer changes which of the two paths matters more.
4. Distribution/update mechanism for a native build (deb repo, AppImage auto-update, Flatpak) is undecided and adds ongoing CI/release surface.
