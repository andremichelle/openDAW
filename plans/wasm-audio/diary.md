# Diary

## 2026-06-16 — Milestone: Step 1 (sine) complete

End to end: Rust DSP → wasm → AudioWorklet → audible 440 Hz sine, deployed and live.

What we have:

- Rust/wasm DSP core in `crates/`: shared `no_std` `dsp` lib + `sine` cdylib, compiled to `wasm32-unknown-unknown`.
- Standalone test app `packages/app/wasm`: vite, JSX router, per-feature page folders.
- AudioWorklet written in TS, bundled by vite via `?worker&url` (no extra tooling).
- CI deploy: `workflow_dispatch` builds Rust + app via turbo and SFTPs to the subdomain through a dedicated `SFTP_WASM_*` account.
- Live at https://wasm.opendaw.studio with COOP/COEP/CORP (SharedArrayBuffer ready).
