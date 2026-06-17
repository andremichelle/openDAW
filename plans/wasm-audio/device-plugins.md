# Device plugins — runtime-loadable WASM

## Goal

Each device is its own WASM module, loaded at runtime, so devices are extendable without rebuilding
the engine (and eventually third-party). Committed from the start. This is the most complex part of
the project.

## The hard part is the ABI, not the loading

A **stable binary interface** every device implements — this is openDAW's own CLAP/VST and is
long-lived, so it must be right. It covers:

- `process(inputs, outputs, params, nframes)`
- parameter layout + value mappings
- telemetry outputs (DSP→UI)
- lifecycle: init / reset / terminate
- buffer & memory layout

Designing this ABI is the bulk of the effort. Runtime loading is a mechanism layered on top.

Two device backends share this contract: **wasm modules** and **JS scripts** (see
`scriptable-devices.md`). Same params/telemetry; wasm devices use the binary ABI, script devices a
wasm→JS bridge.

## Non-negotiable real-time constraints

- **Instantiate off-thread.** WASM compile/instantiate is async and cannot run on the audio thread.
  Devices are loaded before play and handed to the worklet ready-to-run.
- **Hot path stays in wasm.** Host invokes devices **wasm-to-wasm via shared memory** (function
  table) — never host-wasm → JS → device-wasm per quantum. Mechanism + the allocator problem: see
  `05-memory.md` (and the spike that gates it).
- **Zero-copy vs isolation.** Shared linear memory = fast but a bad device can corrupt the engine;
  per-module memory = isolation but copies. Trusted (our) devices → shared; untrusted → isolation.

## Composition mechanism (decision)

- **WASM Component Model (WIT)** — standard typed composition; right long-term, but real-time /
  AudioWorklet maturity is thin today.
- **Hand-rolled C-ABI + shared memory** — full control, works now, more manual.
- Proposal: **custom C-ABI now**, kept WIT-shaped so we can adopt the component model later.

## CLAP alignment (option)

Our device model already lands in the **same family as [CLAP](https://github.com/free-audio/clap)**:
stable C-ABI, host-instantiated per-instance plugins, block `process` with multi-port audio,
declared parameters, UI/DSP split. ~60–70% conceptual overlap by construction. We are **not** aiming
for CLAP compatibility in the current plan, but it is worth keeping the door open.

- **Cheap to keep open:** shape the descriptor / param / (future) event structs to mirror CLAP's
  layouts (`clap_process`, params ext, event queue). Costs little now, buys familiarity and a
  possible future shim to port CLAP plugins compiled to wasm32.
- **What still diverges (by design):** shared single linear memory (CLAP assumes per-plugin address
  space — this is our biggest mismatch and the source of the relocation / shadow-stack work in
  `05-memory.md`); host-owned **box-graph state** vs CLAP's opaque state blob; single-threaded vs
  CLAP's main/audio thread contracts; web TS UI vs embedded native GUI.
- **Reaching actual CLAP** (host real CLAP plugins, or be a CLAP host) is a separate, larger effort:
  CLAP's exact structs, the extension-query mechanism, and the full event/transport model — plus
  solving the shared-memory mismatch. Out of scope for parity; revisit if third-party ecosystem
  interop becomes a goal.

Decision: **stay CLAP-shaped where free**, don't pay for compatibility we don't need yet.

## Packaging implication

If devices are runtime plugins, their **UI (TS) must also be loadable**, not baked into the studio
app. A *device package* = wasm (DSP) + UI bundle + manifest (params / value mappings / telemetry /
commands — see `device-contract.md`).

## Phasing

- **ABI first.** Devices become separate crates behind the ABI immediately, so device code is
  identical whether statically composed or dynamically loaded.
- **Phase A:** runtime-load our **own** device `.wasm` (trusted, shared memory, zero-copy),
  instantiated off-thread. Real extensibility for first-party; proves the ABI.
- **Phase B (later):** third-party / untrusted devices → add isolation + manifest/permission model.
  Same ABI.

## Open

- ABI mechanism: custom C-ABI vs component model (proposal: custom now, WIT-shaped).
- How CLAP-shaped to keep the structs (cheap familiarity vs over-fitting a standard we may not adopt).
- Isolation model for untrusted devices (defer to Phase B).
- Device-package format (wasm + UI + manifest) and how the studio discovers/loads it.
