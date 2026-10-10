<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## Maintain project knowledge

The user wants agents to automatically save important details learned about this project in this file, including across tasks and sessions. Update these notes when discovering verified, durable facts, making architectural decisions, or learning recurring development pitfalls. Keep entries concise, correct stale information, and avoid duplicating existing documentation; link to detailed documents when appropriate. Preserve the managed Turborepo block above. Never record credentials, tokens, private keys, or transient process IDs. Do not treat a past successful check as proof that the current code still passes.

## Repository and development environment

- This checkout was set up for local development and feature implementation. `origin` is the user's fork, `https://github.com/polinom/openDAW.git`; `upstream` is `https://github.com/andremichelle/openDAW.git`.
- Start with `introduction.md` for the component/dependency map and `README.md` for upstream setup and contribution guidance. Upstream asks contributors to document AI-assisted work in `plans/` and keep contributions small and focused.
- This is an npm workspace monorepo with TypeScript applications and a Rust/WebAssembly audio engine. Root scripts include `npm run build`, `npm run dev:studio`, and `npm test`.
- Node must be >=23. On this Mac, the default shell resolves Node 22 from `~/.local/bin`, while suitable Node 24 is installed at `/opt/homebrew/opt/node@24/bin`. Rust proxies are installed at `/opt/homebrew/opt/rustup/bin`. Use the following environment for development commands without changing the user's global shell configuration:

  ```sh
  export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/rustup/bin:$PATH"
  npm run dev:studio
  ```

- Rust stable and nightly are installed with `wasm32-unknown-unknown`; nightly also has `rust-src` for device builds using `-Zbuild-std=core`. Homebrew provides `mkcert` and Binaryen (`wasm-opt`).
- HTTPS certificates are generated with `npm run cert`. Trusting the local CA with `mkcert -install` may require the user to enter their macOS administrator password in their own Terminal. Do not assume system trust has been completed.
- The documented Studio URL is `https://localhost:8080` (the port matters for the sample API's CORS policy). Check the actual server output: another running instance can cause a different port, such as 8081.
- In Codex's restricted sandbox, the `tsx` generator can fail with `listen EPERM` for its local IPC socket, and localhost requests can fail despite a running server. Use the normal approval mechanism for a required retry outside the sandbox.

## Project persistence

- Saved DAW projects, imported samples, and soundfonts live in the browser's Origin Private File System (OPFS). The browser/profile and origin (scheme, hostname, and port) determine the storage library. `https://opendaw.studio`, `https://localhost:8080`, and `https://localhost:8081` have separate libraries.
- Project files use OPFS paths `projects/v1/<uuid>/project.od`, `meta.json`, and optional `image.bin`; see `packages/studio/core/src/project/ProjectPaths.ts` and `ProjectStorage.ts`.
- To move a project between hosted and development instances, export a Project Bundle (`.odb`) and use Open Bundle/import in the destination. Bundles include the project's samples and soundfonts. Cloud Backup offers Dropbox/Google Drive; local OAuth callbacks may depend on registered origins.
- Browser site-data deletion can remove the library. See `packages/app/manual/public/project-management.md` for storage, backup, and sharing instructions.

## Device implementation notes

- Tuner visual styling uses openDAW's shared `Colors`, `DisplayPaint` and Rubik `Fonts`, plus CSS `--color-*` tokens. Bottom native buttons reuse Gate's `ParameterToggleButton.sass` (compact 15px, dark fill, blue active state), not framed/glowing controls. Their left inset follows the actual canvas plot transform. Reference reuses Revamp's ParameterLabel/RelativeUnitValueDragging. Display is borderless/transparent with Revamp-style muted axis labels and thin neutral guides. In-tune feedback is green; detuned feedback is orange.
- History's right-hand Y axis uses labeled note-key bands, with the detected key highlighted green using the readout's smoothed note and fade envelope. `TunerHistoryAxis` clips bands to the plot and is covered by pan/zoom layout tests.
- Footer order is Meter, Histogram (the user's requested label for pitch history), ct/Hz, mode, Reference. Mode is Target/Strobe in Meter and Auto/Manual in Histogram. Switching to Manual freezes the currently visible center into historyCenter. Keep one view-independent canvas inset and fixed mode/unit widths so switching views/units never shifts the buttons.

- openDAW's octave naming uses `Math.floor(midi / 12) - 2` (`MidiKeys.toFullString`): MIDI 60 is C3 and MIDI 69 / 440 Hz is A3. Tuner labels must match this convention, including history and reference accessibility text; it differs from scientific pitch notation by one octave without changing audio frequency.

- Standalone Tuner implementation and AI-assisted design notes: `plans/tuner.md`; user manual: `packages/app/manual/public/devices/audio/tuner.md`. The user chose an original straight cents scale with a downward triangle marker, replacing the Ableton-style arc/ball. Bottom text tabs select Meter or Histogram; the contextual mode button switches Target/Strobe or Auto/Manual. Readings hold for 120ms then fade over 1000ms; this visual release never adds stale samples to live history.
- New audio devices require schema registration in forge-boxes, an adapter and BoxAdapters visitor, EffectBox/EffectFactories registration, DeviceEditorFactory registration, and a Rust WASM side module listed in core-wasm's engine-modules.ts and build-wasm.sh. Build regenerates the ignored TypeScript boxes/exports and tracked Rust box registry; edit the schema, not generated boxes.
- Tuner telemetry at `adapter.address.append(0)` is `[frequencyHz, confidence, levelDbFS]`. Its Rust detector uses fixed storage and stronger-channel Auto selection; Reference and Smooth are display-only controls. View/calibration fields persist in the project; history samples do not.
- DevicePanel is fixed at 248px; `mixins.Control` allocates 192px including padding. Tuner uses a meter-only panel with bottom view tabs, ct/Hz and editable Reference; no settings sidebar. `TunerCanvasLayout` uniformly scales/centers its 480×240 artwork to preserve marker and text proportions. Legacy settings remain persisted for compatibility. Own animation/subscriptions/events through the editor lifecycle.
- Focused tuner checks: `cargo test --manifest-path crates/Cargo.toml -p device-tuner` and `npm run test:vitest --workspace=@opendaw/studio-core-wasm -- test/tuner-device.test.ts`. WASM no_std device code must use libm for floating-point floor/ceil.
