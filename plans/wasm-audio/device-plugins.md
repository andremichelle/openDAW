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
- Isolation model for untrusted devices (defer to Phase B).
- Device-package format (wasm + UI + manifest) and how the studio discovers/loads it.
