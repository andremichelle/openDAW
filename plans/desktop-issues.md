# Desktop issues (testers, Windows VM, Linux)

Every small issue in one place, we jump between them depending on what the Windows build allows. Status words: open,
waiting (for a tester or André), fixed (shipped, with the commit), done (confirmed).

## Windows

| # | Issue | Status |
|---|---|---|
| 1 | Studio does not boot sometimes, preloader spins forever | open: the page stays alive (animation runs, console answers), a command in the console let it go on; `[boot]` markers now land in openDAW.log, the last one names the step |
| 2 | Dashboard jumps around while it builds at the start | open: suspects the menu bar appearing late and scrollbars taking width, waiting for a short recording |
| 3 | Studio jumps for a frame on project change, menu click, Audio Settings | fixed `e67ecdb57` (menu updated in place, desktop-test-18), waiting for confirmation |
| 4 | WebCLAP window black when it opens automatically after picking a plugin (opening by hand works) | open: `[wclap trace]` now lands in openDAW.log, waiting for the lines of an automatic open |
| 5 | WebCLAP editor not connected to the sound (also macOS) | done `d34ddbd61` (bridge kept values of another window by tag) |
| 6 | WebCLAP window too small, plugin clipped | done `39d043a5e` |
| 7 | Audio engine errors every few minutes (os error 997) | fixed `5ae0a7251`, waiting for the tester |
| 8 | No Mode row, engine audio settings deadlock | fixed `f313c154a`, waiting for confirmation that Mode shows |
| 9 | Latency about 90 ms in shared mode | partly fixed `f313c154a` (reserve follows recent callbacks), device latency is Windows shared mode; the VM had Buffer Size 1024, so the reserve floor is 2048 frames (42 ms), 128 lets it drop to about 20 ms |
| 10 | Exclusive mode only gets to 60 ms on the VM | open: waiting for `exclusive output ... period N (the card allows M)`, next: reserve of one period plus margin in exclusive mode, real hardware decides |
| 11 | `[latency]` line too chatty | fixed `f313c154a` for the device jitter; still flips between the buffer floor and two callbacks (2048/2112), open: log only changes above 10% |
| 12 | VST3 plugin windows stutter (low fps), sound clean | open: waiting for OS, VM or not, which plugins |
| 13 | A VST3 fails to load with E_NOINTERFACE (createInstance -2147467262) | open: the log does not name the plugin, the load message should |
| 14 | Engine stalls up to 1 s ("max timers"), underruns | open: needs its own measurement |
| 15 | Zoom (Ctrl +/-/0) | fixed in desktop-test-17, not confirmed on Windows |
| 16 | Self-update 0.0.17 to 0.0.18 | waiting: does a 17 app offer the restart |
| 17 | Uninstall from Tools | untested on Windows (NSIS uninstaller, hook for the plugin cache) |
| 23 | A "JSON" error kept the studio from starting | open: waiting for the message, it should now land in openDAW.log |
| 24 | The inspector's console cannot be copied in the VM | fixed: DesktopConsole writes console errors, warnings, `[boot]` and `[wclap trace]` lines into openDAW.log (`[studio ...]`) |

## Linux

| # | Issue | Status |
|---|---|---|
| 18 | Does not start, "SharedArrayBuffer not available" | open: waiting for testers (log line with the WebKitGTK version, start with JSC_useSharedArrayBuffer=1) |
| 19 | `.deb` program name assumed `opendaw` in the tester note | unverified |

## All platforms

| # | Issue | Status |
|---|---|---|
| 20 | Surge, Six Sines: "Read-only file system: '/user'" (WebCLAP has no writable user folder), maybe why Six Sines plays only a sine | open |
| 21 | Installer page and log show 0.0.1 instead of the build's version | fixed `65a122f56`, ships with desktop-test-19 |
| 22 | Temporary `[wclap trace]` in WclapWindows.tsx and wclap-frame.html, `[boot]` markers in boot.ts | remove once #4 and #1 are solved |

## Decided

- Exclusive mode stays a choice, shared is the default (other programs keep their sound, every card works).
- No ASIO for now (Steinberg license).
