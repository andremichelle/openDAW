# Diary

## 2026-06-17 — Milestone: Step 2 (composition spike) complete

Two independently compiled wasm modules share one linear memory and call each other wasm-to-wasm.

What we have:

- `compose-engine` + `compose-device` crates: engine generates a sine into an engine-owned arena and calls the device's `process` to apply gain, with no JS in the loop.
- Both import one shared `Memory` (`--import-memory` via `build.rs`); engine owns layout, device is stateless. No allocator collision.
- Test page `/compose`: audible result plus an in-page verify and benchmark.
- Memory model A validated. About 250 ns/block in Node, 500 ns/block in the browser.
- Hardened with two STATEFUL devices chained (`/chain`): a one-pole lowpass and a feedback delay, each with private state, plus the engine, all in one shared memory. Each module is relocated with `--global-base` (engine 1 MiB, lowpass 4 MiB, delay 8 MiB) so their state slabs are disjoint. Without that they all cluster at ~1 MiB and corrupt each other.
- Verified bit-faithful against an f32 reference (max error 3e-8 over 64 blocks), state persists across blocks, and one device's state is byte-identical after 100k calls into the other. About 700 ns/block for the 2-device chain.
- Ring modulator (`/ring`): proved a descriptor-based ABI for arbitrary I/O. The engine writes a small descriptor into shared memory (input offsets, output offset, frames, params) and the device reads two inputs and writes a separate output. Spectrum is textbook ring mod (sidebands at 330 + 550 Hz, originals gone), parity 3e-8.
- Multi-instance (`/osc`): one oscillator module backs two instances at different frequencies, each with its own engine-assigned state block. Both tones clean and independent (parity 6e-8); forcing them to share one state block collapses both. Established the rule: device state is per-instance and external, never a module `static`. Plugin architecture de-risked.
- Boundary made safe: the `abi` crate holds the only `unsafe` (`Ports::from_descriptor` turns the descriptor into safe slices + typed state); device DSP is 100% safe Rust. `osc` is the reference, verified bit-identical after the conversion.
- The exploratory spikes (compose / chain / ring / osc) were consolidated into one comprehensive rack (`/rack`) once their findings were captured. Lean crate set: `abi`, `dsp`, `sine`, `comp-engine`, `comp-filter`, `comp-ring`, `comp-delay`.
- The rack exercises every axis at once: engine + two filter instances + ring mod + heap-allocating delay, four independent modules in one shared memory. Verified: data/heap/state regions disjoint (engine 1 / filter 4 / ring 8 / delay 13 MiB), full-rack parity bit-exact (3e-8), heap device allocates from its own arena, ~1 µs/block. Multi-instance, multi-input descriptor ABI, per-instance state, and safe DSP all covered.
- Found (unsolved): rust-lld pins every module's shadow stack at `[0, stack-size)`, so the modules' stacks overlap. Harmless for register-only DSP (today) but a real risk for spilling devices. See `05-memory.md` for options (per-device memory / no-spill / patch stack pointer).

## 2026-06-16 — Milestone: Step 1 (sine) complete

End to end: Rust DSP → wasm → AudioWorklet → audible 440 Hz sine, deployed and live.

What we have:

- Rust/wasm DSP core in `crates/`: shared `no_std` `dsp` lib + `sine` cdylib, compiled to `wasm32-unknown-unknown`.
- Standalone test app `packages/app/wasm`: vite, JSX router, per-feature page folders.
- AudioWorklet written in TS, bundled by vite via `?worker&url` (no extra tooling).
- CI deploy: `workflow_dispatch` builds Rust + app via turbo and SFTPs to the subdomain through a dedicated `SFTP_WASM_*` account.
- Live at https://wasm.opendaw.studio with COOP/COEP/CORP (SharedArrayBuffer ready).
