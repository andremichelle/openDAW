# Tauri macOS wrapper (first slice)

Related: [#23 Native Version](https://github.com/andremichelle/openDAW/issues/23),
[`plans/issues/023-native-version.md`](issues/023-native-version.md).
This slice does **not** close #23 (that issue asked for a Linux install).

## Status

First slice only: a Tauri 2 **macOS** shell that loads the existing `@opendaw/app-studio`
webview. Not a DAW rewrite, not a native audio backend, not an OPFS replacement, and not
Windows/Linux packaging.

## Why this shape

README contributor ask #1 is wrapping openDAW with Tauri. `packages/app/lab/` is the
sibling-app layout this package follows (`packages/app/desktop/`). The studio is left
untouched; the shell only points at its Vite URL (dev) or `dist/` (release).

`Browser.isTauriApp()` already exists in `@opendaw/lib-dom` (`"__TAURI__" in window`).
`withGlobalTauri: true` makes that helper true inside the webview without changing studio.

## How it boots

| Mode | What the webview loads | Who sets COOP/COEP |
|------|------------------------|--------------------|
| `npm run dev:desktop` | `https://localhost:8080` (studio Vite) | studio `vite.config.ts` (same as the browser) |
| `npm run build:desktop` | `@opendaw/app-studio` `dist/` via Tauri's custom protocol | `app.security.headers` in `src-tauri/tauri.conf.json` |

Studio aborts in `packages/app/studio/src/main.ts` if `!window.crossOriginIsolated`.
The three headers match the studio/Apache set: COOP `same-origin`, COEP `require-corp`,
CORP `cross-origin`. CSP is left `null` so the existing studio (worklets, workers, WASM,
Monaco, cloud assets) is not rewritten to satisfy a new policy.

The desktop package has **no** `build` script so `turbo build` / `npm run build` does not
try to produce a `.app` on Linux CI.

## Commands

Prerequisites are the same as `npm run dev:studio` (`npm run cert`, `npm install`,
`npm run build` once). Desktop `dev` starts studio Vite itself via `beforeDevCommand`.

```
npm run dev:desktop     # Tauri webview + studio Vite (macOS)
npm run build:desktop   # .app / .dmg; must be run on a Mac
```

This slice was scaffolded on a Linux cloud VM. `cargo check` for
`packages/app/desktop/src-tauri` succeeded (GTK/WebKit headers present so the
Linux host could typecheck the crate). `tauri build` / a macOS `.app` was **not**
produced and is not checked in. The desktop crate wants recent stable Rust
(see `rust-version` in `src-tauri/Cargo.toml`); that is independent of the
nightly toolchain used by `crates/` for WASM.

## Out of scope (later slices)

- Native audio backend / bypassing Web Audio
- Filesystem instead of OPFS
- Windows / Linux installers
- PWA work in `plans/pwa.md`
- Tightening CSP or adding Tauri commands

## Risk to verify on a Mac

WKWebView has historically been uneven about `SharedArrayBuffer` on custom protocols even
when COOP/COEP are present. Dev mode (HTTPS localhost, same headers as the browser) is the
safer isolation path. If a production `.app` reports `crossOriginIsolated === false`, the
next slice is a localhost-plugin or protocol investigation — not a studio rewrite.
