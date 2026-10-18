# Engine updates without a new installer

Requirement: the native audio engine (`opendaw-engine`: V8, the wasm engine bundles, cpal, the VST3 host) ships with
every studio deploy. A tester installs the app once, every later engine fix arrives with the in-app update.

Until now the shell only ran the engine bundled next to it (`engine_binary()`), so every engine change needed a new
installer. That broke the promise of the announcement and the /install page.

## Design

The engine becomes part of each desktop release, like the studio's files.

1. **CI (`deploy.yml`)**: when the desktop variant is built (DEV), a matrix job builds the engine on the installer's
   five runners (macos-arm64, macos-intel, windows, linux, linux-arm64), ad-hoc signs it on macOS and keeps it as an
   artifact. The deploy job waits for all five, puts them in `packages/app/desktop/engine/dist/<platform>/` and then
   builds the desktop studio. A missing engine fails the deploy, a release never goes out without its engines.
2. **Release (`vite.config.ts`)**: `desktop-components` copies `engine/dist` to `engine/` in `dist-desktop`. The
   manifest lists each engine file with its sha256 under the component `engine-<platform>`. Components are only
   downloaded when selected, so shells that predate this skip all five engines.
3. **Shell (`update.rs`)**: downloads its own platform's engine with the release (verified like every file, reused
   from the installed build when unchanged). No other platform's engine is downloaded.
4. **Shell (`main.rs`)**: `engine_binary(root)` runs `root/engine/<platform>/opendaw-engine[.exe]` (marked executable
   on macOS and Linux). A debug build runs the engine crate's release build, `OPENDAW_ENGINE` overrides both. A
   rollback to the previous build (`watch_boot`) restarts the engine from that build, so studio and engine always
   come from the same release.
5. **Shell API 2**: releases with engines need this shell. Older shells keep their installed build and do not take
   newer ones, so they never run a new studio with an old engine. Testers install once more, then never again for
   engine changes.

## Installer and PROD

- The installers no longer bundle an engine (no sidecar): the first start downloads the studio anyway and needs the
  internet, offline starts run the installed release's engine. The installer is the shell only, a few MB.
- PROD deploys (`main`): no desktop variant, no engine job.

## Follow-ups

- Brotli for the engines (about 45 MB each): the server sets `Content-Encoding` only for known extensions, an
  extensionless `.br` would fail verification. Unchanged engines are reused from the installed build already.
- Engine tests in CI on all five runners (the engine job could run `cargo test` too).

## Status

- 2026-10-18: implemented (shell, vite, deploy workflow), shell API 2, the bundled engine removed. Needs one more
  installer for testers.
