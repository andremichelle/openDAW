# Cherry-picks from tauri-desktop-app into PROD

The desktop branch is frozen (`plans/desktop-freeze.md`). Of its 114 commits, 71 touch code outside the desktop
packages. Compared against `main` (merge base `98efab88f`, main has no commits since), checked by dry-run merges. Most of
it is desktop plumbing. A handful of changes help the browser studio and can go in alone.

## Take

| # | What | Commit | Value for PROD | How |
|---|---|---|---|---|
| 1 | "Open Bundle File from Disk..." as a top-level File item next to "Save Bundle File to Disk...", out of File > Import | `177fd2e11` (StudioMenu.ts hunk only) | Save and open a bundle sit together | apply the StudioMenu.ts hunk by hand (+2/-2), the rest of the commit is desktop. Not the branch's `Browser.isLocalHost()` to `Platform.isDevelopment()` change (other commit) |
| 2 | Deploy uploads in 16 MB chunks, each unpacked before the next, at most 150 files per chunk, a failed chunk sent again (3 attempts, 30 s apart) | `15a25886e`, `053474c05` | Fixes the PROD deploy failure where the server killed the unpack (tar exit 9) | clean, adds deploy/chunks.ts (+test). Needs the extract.php lock, already live. Without the desktop parts of run.ts (deployDesktop, /dev/tauri, /install rules, the 127.0.0.1:47110 CORS origin) |
| 3 | Remove the htdemucs spike page | `222f26b18` | PROD bundle no longer ships a second 27 MB ONNX runtime | clean except plans/tauri.md (drop it). Removes SpikeTestPage.tsx/.sass, its route in App.tsx, the /spike-test line in robots.txt |
| 4 | WebCLAP window fits a fixed-size plugin | `39d043a5e` (WclapWindows.tsx, FloatingWindow.tsx only) | Fixes a browser bug: a fixed-size plugin opened at the default zoom (75%), refused it, and a popout window stayed small, the plugin clipped or scrolling | FloatingWindow.tsx clean, the one-line WclapWindows.tsx change (scale only for resizable plugins) by hand. Not whenLoaded.ts, Surface.tsx, Shell.ts (desktop shell gate) |
| 5 | A project without samples or soundfonts no longer fetches the catalogue on load | `a498365de` (AssetService.ts only) + its test case from `49c014fa6` | An empty or synth-only project opens without waiting for the index | AssetService.ts hunk clean, plus the case "does not ask for the catalog when the project has no such files" in AssetServiceCatalogUnreachable.test.ts. Not IndexFetch/OpenSampleAPI/OpenSoundfontAPI/OpenDAWCloud (need OpenDAWCloud, desktop) |
| 6 | boxgraph checksum: per-box fold cache, block-wise folds, ASCII fast path for strings (bit-identical) | `a38d0b97d` | Faster engine checksums, most for large string fields | clean (main never touched crates/boxgraph). Run cargo test and the TS/wasm checksum parity tests after |

## Maybe

| # | What | Commit | Why not now |
|---|---|---|---|
| 7 | Back buttons on Imprint, Privacy, Manifesto, top left | `055d3aaca`, `8f3934338` (those pages and BackButton.sass only) | A visible change to how these pages look in the browser, made for the desktop (no browser navigation). Your call |
| 8 | Discord deploy post only for PROD deploys | `574b65118` | A deliberate behaviour change, small. Your call |
| 9 | Live rooms send bytes fields as raw bytes | `2a8447cee` | Clean and harmless, but PROD has no bytes fields, the bug is latent. Take when PROD gets one |

## Leave on the branch

- **yjs-server limits** (`b096b91e9`, `772941498`): 256 connections per IP, a message rate limit, a "Live Room Full"
  dialog. A behaviour change on the production live-room server, the rate limit could cut off heavy sessions and the
  cap shared school networks. If wanted, one squashed server change without the desktop origin, deployed deliberately.
- **Platform seams** (`43bc963d6`, and what follows from it: Preferences.ts, Router.tsx, ErrorHandler.ts,
  StorageInspector.ts, Workers.ts): behaviour-neutral plumbing for the desktop, 54 files, nothing for the browser.
- **MIDI and audio input strategies** (`64272f3bc`, `ee8622f24`, RecordingTake.ts): refactors for the native engine,
  the hot-plug is native only. A regression risk for recording in PROD without a gain.
- **vite.config.ts**: everything behind `mode === "desktop"`.
- **Inference hooks** (InferenceConfig, ModelStore, InferenceLoader): the desktop supplying models itself, inert on the web.
- **Everything native**: NativeInstrumentBox/NativeEffectBox and their adapters, ParametersMenu.tsx, native device
  editors, the engine crates' native parameters, core-wasm host imports, EngineVariant/OfflineEngineRenderer changes,
  Footer and PerformanceStats sample rate, AudioOutputSelector modes, manuals.ts component host, Header.tsx native menu,
  the bytes-field checksum test (imports NativeInstrumentBox).

## Order

One change per commit on `main`, each tested before the next. 1 to 5 are studio and deploy changes with low risk, 6
touches the engine (cargo test, checksum parity). The deploy change (2) first, the next PROD deploy then benefits.
