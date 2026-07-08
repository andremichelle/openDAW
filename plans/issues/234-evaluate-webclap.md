# Evaluate WebCLAP (#234)

**Doability:** ⭐⭐⭐⭐⭐ (5/5) — pure research/evaluation, no code change, findings already largely gathered.
**Type:** feature (research/evaluation)
**Scope:** small

## What is asked
Evaluate WebCLAP — CLAP (CLever Audio Plugin) running in the browser via WebAssembly — as a possible plugin format for openDAW. Reporter links: `github.com/WebCLAP` (spec/host implementation), an IRCAM resource (WAC presentation context), and a browser test host. Note: there is a separate, near-duplicate GitHub issue also asking to evaluate WebCLAP — this plan should stand as the canonical evaluation so the duplicate can point back at it.

## Current behaviour / relevant code
openDAW has no plugin-hosting layer today — every device is a first-party TS/JSX component compiled directly into the app (schema in `packages/studio/forge-boxes`, box in `packages/studio/boxes`, adapter in `packages/studio/adapters`, processor in `packages/studio/core-processors`, editor in `packages/app/studio`). All device DSP runs as plain classes inside the single `EngineProcessor` AudioWorklet (`packages/studio/core-processors/src/register.ts` → `core/dist/processors.js`).

This exact question was already researched as part of drafting `plans/loading-devices-at-runtime.md` (#170), which contains a "WebCLAP Analysis" section with a firm recommendation: **do not adopt now**. Its findings, restated here as the dedicated evaluation:

1. **Architecture mismatch** — openDAW devices are deeply integrated with the box-graph (automation, undo/redo, real-time collaboration via Yjs). WebCLAP's model is a `.wasm` module exporting `clap_entry` per the C ABI; hosting one means building an entirely separate bridge layer that has none of that integration for free.
2. **UI incompatibility** — openDAW device editors are built from shared controls (`ControlBuilder.createKnob`, `ParameterLabelKnob`, `DevicePeakMeter`) wired into box editing, automation, and MIDI-learn. WebCLAP plugin UIs are typically hosted in isolated iframes with no access to those shared controls or the box-graph.
3. **Dual-WASM overhead** — WebCLAP needs a C++ WASM host module to load plugin `.wasm` modules. Since openDAW's own audio engine is separately being ported to Rust/WASM (`plans/wasm-audio/README.md`, #261), this would mean two independent WASM runtimes coexisting in the worklet, which is unnecessary complexity if the goal is just running more devices.
4. **Maturity risk** — early alpha at evaluation time, effectively a single-developer effort (Geraint Luff / Signalsmith Audio), placeholder browser-host implementations, draft (not finalized) spec. Adopting a moving-target spec as a dependency is risky for a project that otherwise keeps external dependencies minimal (project convention: prefer homebrew, minimal deps).
5. **Wrong problem for the current need** — openDAW's actual pain point (tracked in #170) is *internal* device modularity: keeping boot time small and letting the maintainers add devices without a full rebuild. WebCLAP solves *third-party native plugin hosting* (bringing existing CLAP/VST-adjacent plugins into a browser), a different and, for now, lower-priority problem.

## Plan
Since this is a research issue, the "plan" is the deliverable itself:

1. Confirm current status of the three linked resources (WebCLAP spec/host repo, the IRCAM/WAC writeup, the browser test host) — check for spec stabilization and whether iPlug3 or other hosts have shipped since the last look, since "early alpha" is a time-sensitive judgment.
2. Publish the recommendation above as the issue's evaluation outcome: **do not adopt now**, revisit as a possible **future device type** once #170's runtime-loading + sandboxing story exists — a WebCLAP host would then slot in as one more loadable "device" (similar to how NeuralAmp already bridges to an external WASM module, see `project_nam_tone3000_wasm_port` in project memory), rather than as the primary plugin architecture.
3. Close out the duplicate issue by linking it to this evaluation.

## Risks / open questions
- The evaluation is time-sensitive: WebCLAP was "early alpha" as of the last look; re-check before finalizing since browser WASM plugin standards move fast and a stale "not ready" verdict is worse than no verdict.
- If the maintainer's actual interest is third-party plugin hosting (VST-like extensibility) rather than internal device modularity, that changes the priority calculus — worth clarifying intent before fully shelving this, since #170 explicitly treats WebCLAP as a possible *future* device type, not a rejected one.
- No sandboxing story exists yet in openDAW for *any* dynamically loaded code (see #170's own gap on this) — WebCLAP's WASM isolation is actually one of its more attractive properties relative to loading arbitrary TS device code, which is worth weighing if/when #170's sandbox work starts.
