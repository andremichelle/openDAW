# Dynamically load devices into the studio (#170)

**Doability:** ⭐⭐☆☆☆ (2/5) — large architectural refactor touching box-forge, three app packages and the AudioWorklet loading model; sizeable but a complete design already exists.
**Type:** feature, refactoring
**Scope:** large

## What is asked
A system to load devices at runtime instead of compiling them in, so boot time stays small and third parties (eventually) can add custom devices in a sandbox. A device bundles Schema, Box, Adapter, Processor, Editor, Manual. Iteration 1: load the existing stock devices dynamically. Iteration 2: a separate openDAW Device SDK repo for external authors. Edge cases called out by the reporter: versioning/migration of saved projects, sandboxing against panics, UI restrictions for untrusted devices.

## Current behaviour / relevant code
A full, detailed implementation plan for exactly this already exists at `plans/loading-devices-at-runtime.md` (drafted, not started) — do not re-derive the design, extend/execute it. Key facts it establishes:

- Every device today is **statically compiled** into four hardcoded dispatch tables: `BoxAdapters.ts` (`packages/studio/adapters`), `DeviceProcessorFactory.ts` (`packages/studio/core-processors`), `DeviceEditorFactory.tsx` (`packages/app/studio/src/ui/devices`), and `EffectFactories.ts` (`packages/studio/core`) — each a `BoxVisitor` dispatch keyed by generated per-device visitor methods.
- All device DSP runs as plain TS classes inside **one single AudioWorklet** (`EngineProcessor`, bundled via `packages/studio/core-processors/src/register.ts` → `core/dist/processors.js`, loaded once via `audioWorklet.addModule()`). `AudioWorkletGlobalScope` cannot `import()`/`fetch()`/`importScripts()` — the only way to inject code into it at runtime is additional `addModule()` calls from the main thread, and those share the global scope (hence the plan's `globalThis.openDAW` bridge for shared processor infra).
- 26 devices total today (14 audio effects, 7 instruments, 5 MIDI effects) — full inventory in the plan.

## Plan
Follow `plans/loading-devices-at-runtime.md` phases as written:

1. **Phase 1 (decouple, steps 1-5)** — purely additive until step 4: add `visitRuntimeDeviceBox` to the generated `BoxVisitor` (box-forge change), a `DeviceBoxRegistry` (`packages/studio/boxes/src/DeviceBoxRegistry.ts`) and `DeviceRegistry`/`DeviceDescriptor` (`packages/studio/core/src`), register all existing devices behind it, then switch every device box's `accept()` to route through the shared visitor entry, then delete the now-dead per-device dispatch code.
2. **Phase 2 (build pipeline, steps 6-7)** — new `@opendaw/device-sdk` (UI/adapters/processor re-exports), `@opendaw/device-forge` (schema → generated real Box subclasses + `manifest.json`, mirroring today's `box-forge`), `@opendaw/device-bundle` (esbuild, three bundles per device: `adapter.js`/`editor.js` for main-thread `import()`, `processor.js` for `audioWorklet.addModule()`), and a `DeviceLoader` that reads `devices.json` and wires everything at boot before project load.
3. **Migration (steps 8-10)** — move Fold first as the proof of concept, then migrate the remaining 25 devices in the plan's stated order (simple effects → medium → complex → MIDI → instruments), then delete legacy scaffolding.

This plan's own iteration split matches the issue: step 8 (Fold PoC) + step 9 (remaining stock devices) is "iteration 1." A separate `@opendaw/device-sdk`-consuming external repo is "iteration 2," out of scope for the openDAW monorepo itself beyond publishing the SDK package.

## Risks / open questions
Already captured in the existing plan's own risk section, worth restating since the reporter explicitly flagged them:

- **Sandboxing against panics/malicious code** is not solved by the existing plan — it solves *runtime loading*, not *isolation*. Loaded device processor code still runs inside the shared `AudioWorkletGlobalScope` with full access to `globalThis.openDAW` and the same memory as every other device; a bad device can still crash the whole worklet or corrupt shared state. True sandboxing (e.g. per-device Worker, or a WASM-based sandbox akin to the WebCLAP evaluation in #234) is a separate, harder problem than the file-based dynamic-loading mechanism this plan builds, and should be scoped as a distinct follow-up before "load from external sources" (iteration 2) is safe to expose to arbitrary third parties.
- **Versioning/migration**: the existing plan flags this as an explicit open question (#1 in its Open Questions section) — no answer drafted yet for what happens when a device's manifest/parameter layout changes after projects have already serialized boxes against the old layout.
- **Step 4 (switch-over)** is marked medium risk in the source plan — flipping all `accept()` methods to the shared visitor at once is the highest-blast-radius single change; can be done incrementally per-device instead.
- **WebCLAP** was evaluated as part of this plan's research (recommendation: do not adopt now — see `plans/issues/234-evaluate-webclap.md`) since it solves third-party native plugin hosting, not openDAW's internal device modularity problem, but is worth revisiting once runtime loading + a sandbox story exist.
