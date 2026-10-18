# Desktop app: frozen (2026-10-18)

The Tauri desktop app with native VST3 hosting is frozen on the branch `tauri-desktop-app`. No further rounds until the
next attempt is set up differently. The browser studio is not affected.

## Why

Too much friction for what reaches the user.

- **Three web engines.** Tauri uses the system webview: Safari's engine on macOS, Edge's Chromium on Windows,
  WebKitGTK on Linux. The studio is developed and tested in Chrome. Every difference is found separately, on Linux the
  app never started (SharedArrayBuffer hidden by WebKitGTK).
- **Fixes break other platforms.** Most changes touched all three platforms and could only be checked afterwards. A
  deadlock in the engine's audio settings reached Windows testers, the menu refill made by the Windows flicker fix broke
  the menu on macOS.
- **Windows was tested blind.** Only a VM was available: no real audio, unreliable graphics. VM artifacts and real bugs
  could not be told apart. Testers report unstable audio on Windows.
- **The native menu bar on Windows** is part of the window, replacing it lets the studio jump. Production apps draw their
  menu inside the page on Windows and Linux.
- **VST hosting is not stable yet.** Crashes and undo problems were fixed one by one (Microtonic, Serum, the plugin's own
  history), more keep coming.
- **Deploy times.** A DEV deploy takes about 30 minutes, 17 of them uploading the desktop release (five engines, maps
  and uncompressed copies nobody downloads). One round per fix is too slow.

## What works and stays on the branch

- macOS: the native engine, VST3 hosting with its own history, WebCLAP editors connected, plugin windows.
- The engine ships with every deploy (no new installer for engine fixes), the app updates itself, small installers,
  uninstall from Tools.
- `plans/desktop-issues.md` lists every open issue at the time of the freeze.

## Before the next attempt

1. **One engine everywhere.** Evaluate Tauri's CEF runtime (Chromium inside Tauri, keeps the Rust shell and the native
   engine) against Electron. The same Chromium on all platforms removes the Linux and Safari class of problems.
2. **No native menu bar on Windows and Linux.** Use the studio's own menu inside the page, native only on macOS.
3. **Real hardware.** A Windows machine with a real audio interface, a Linux machine, before testers get builds.
4. **Engine tests in CI on all five platforms**, and one change per build, checked on each platform before it ships.
5. **Faster deploys.** Upload only what the app downloads (about 100 MB instead of 460 MB), a desktop-only deploy that
   skips the web studio.
6. **Audio on Windows.** WASAPI exclusive mode exists but is unproven on real hardware, ASIO needs the Steinberg license.
7. **VST stability.** A crash-proof plugin host (plugins in their own process) before it reaches users.

## State at the freeze

Uncommitted on the branch: the app update at launch before the studio, the About details, Help menu links. Temporary
diagnostics are still in the code (`[boot]` markers, `[wclap trace]`, `plans/desktop-issues.md` #22).
