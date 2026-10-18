# The app updates itself

`plans/tauri.md` promised "The shell updates itself through the Tauri updater". It never existed, so every change
to the app itself (the Linux SharedArrayBuffer fix, the shell API bump) needed a manual reinstall, and a studio
release needing a newer app left installed apps silently on their old studio. With this, the coming install is
really the last one a tester does by hand.

## Design

1. **Key**: a minisign key pair (`cargo tauri signer generate`). The public key is in `tauri.conf.json`
   (`plugins.updater.pubkey`), the private key is the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`. Losing it means no
   app can update again, back it up.
2. **Versions**: the updater compares versions. A tag `desktop-test-<n>` builds version `0.0.<n>`, a tag
   `desktop-v<version>` the version in `tauri.conf.json` (checked as before).
3. **Artifacts (`desktop.yml`)**: the build signs the updater artifacts (`createUpdaterArtifacts` only in CI, local
   builds need no key): macOS `.app.tar.gz`, Windows the NSIS setup, Linux the AppImage and the deb where the
   bundler signs it, each with its `.sig`. The
   install job writes `openDAW-latest.json` (version, per platform url and signature) next to the installers on
   `/install`. The endpoint follows `OPENDAW_UPDATE_ORIGIN`.
4. **Shell (`shell_update.rs`)**: checks at launch and every 6 hours, downloads in the background, then asks
   "openDAW <version> is ready. Restart now?" (Restart, Later). macOS and Linux install right after the download
   (the new version runs from the next start), Windows when the app exits (its passive installer closes the app).
   Restart goes through the page's unsaved-work guard (`request_quit`) and starts the app again.
5. **A deb install** updates through `dpkg` with a password prompt (`pkexec`), the plugin does that. Where no signed
   deb is in the feed, or any install fails, the app says so with the download link.
6. **A studio release needing a newer app** (`shellApi` above the shell's): when no app update is found, the shell
   says so with the download link (it used to only log it).

7. **Releases (`desktop-v<version>`)**: the release job writes the feed with the release's GitHub asset URLs,
   attaches it and puts it in the update origin's install folder (`/dev/install`, or `/main/install` once the origin
   is PROD; the root `.htaccess` routes `opendaw.studio/install/openDAW-*` there).
8. **macOS quit**: a quit from the menu answers the system's terminate request, tao turns `applicationWillTerminate`
   into `LoopDestroyed`, Tauri into `RunEvent::Exit`, so the exit hook runs there too (checked in the sources).
9. **Uninstall (`uninstall.rs`, `plans/tauri.md` phase 6)**: Tools > Uninstall openDAW (shell API 3, older apps show
   it disabled) asks twice: uninstall, then keep or delete the projects, samples and settings (keep is the default
   button). On exit it removes the downloaded builds, components, logs and the plugin scan cache, everything else
   too when asked, then the app: macOS the `.app`, Linux the AppImage (a deb is the package manager's, the dialog
   says so), Windows runs the NSIS uninstaller. That uninstaller's "Delete the application data" also removes the
   plugin scan cache now (`windows/hooks.nsh`).

## Later

- Signing and notarization (macOS Developer ID, Windows Authenticode) for the public release.

## Status

- 2026-10-18: implemented, all points above. The key is in `~/.tauri/opendaw-updater.key` on André's machine and the GitHub secret
  `TAURI_SIGNING_PRIVATE_KEY`. Needs one installer (the last manual one).
