# 01 — Language choice

The single most consequential decision. The core runs in an **AudioWorklet** (real-time thread), so
the hard constraint is **no GC pauses and no allocation on the audio callback** — a GC stall = audible
dropout. Everything else (ecosystem, syntax) is secondary to that.

**All DSP is homebrew** — no JUCE / third-party code (licensing). So the "DSP ecosystem" criterion is
deprioritized: we port every algorithm ourselves no matter the language, which removes C++'s main
advantage and makes the choice mostly about RT-safety, tooling, and testing.

## Criteria

- **RT-safe** — no garbage collector / deterministic memory (the dealbreaker)
- **WASM toolchain** — maturity of compiler + JS/TS bindings
- **SIMD + threads** — wasm SIMD128 and shared-memory threads support
- **DSP ecosystem** — existing audio/DSP libraries to lean on
- **TS-closeness** — how close to the current TS reference (eases translation + review)
- **Testing** — can we test DSP both natively and in-wasm easily (our main safety net)
- **Maintainability** — long-term for a mostly-TS team

## Comparison

| Language | RT-safe (no GC) | WASM toolchain | SIMD/threads | DSP ecosystem | TS-closeness | Testing | Verdict |
|---|---|---|---|---|---|---|---|
| **Rust** | ✅ ownership, no GC | ✅ mature (wasm-bindgen/wasm-pack) | ✅ both | ✅ good (fundsp, dasp) | ⚠️ different | ✅ excellent (native + wasm) | **Recommended** |
| **C++** | ✅ manual | ✅ mature (Emscripten) | ✅ both | ✅ largest (reference DSP) | ⚠️ different | ⚠️ ok, heavier setup | Strong runner-up |
| **Zig** | ✅ manual | ✅ first-class wasm | ✅ both | ⚠️ small | ⚠️ different | ✅ built-in | Viable, smaller community |
| **AssemblyScript** | ⚠️ has GC (avoidable in hot path) | ✅ purpose-built for wasm | ✅ both | ❌ thin | ✅ TS-like | ⚠️ wasm-only, immature | Non-RT glue only |
| **C** | ✅ manual | ✅ mature (Emscripten) | ✅ both | ✅ large | ⚠️ different | ⚠️ manual | Viable but low-level |
| **Go (TinyGo)** | ❌ GC (even TinyGo) | ⚠️ TinyGo only | ⚠️ limited | ⚠️ small | ⚠️ different | ✅ good | **Ruled out** (GC) |

(Also-rans, not seriously considered for the RT core: C#/Blazor, Kotlin/Wasm, Swift — all GC or
immature for wasm audio.)

## Recommendation: **Rust**

- No GC → real-time safe by construction; ownership gives deterministic teardown without manual
  `free`. This is the decisive factor.
- Mature wasm story (SIMD, threads, `wasm-pack`), small binaries, fast startup.
- **Testing is the strongest** of the set: the same DSP code runs as fast native `cargo test` *and*
  in-wasm — exactly what we need since correctness is verified by tests, not code review. We can run
  the reference harness (vs the TS engine) natively in CI for speed and in-wasm for fidelity.
- Healthy audio/DSP crates to borrow algorithms from.

**Runner-up: C++** — its one real edge (mature DSP ecosystem) is moot now that everything is
homebrew, and it costs us manual-memory risk + heavier build/test setup. No longer compelling.

**AssemblyScript** is tempting because it reads like the TS reference, but its GC and thin/immature
real-time track record make it a poor bet for the audio thread on our most complex feature. At most
it could write non-real-time glue — not worth introducing a second language for that.

**Go is out**: its GC (and TinyGo's) is incompatible with glitch-free real-time audio.

## Decision: Rust

With all-homebrew DSP, C++'s ecosystem edge disappears and Rust wins cleanly on RT-safety + tooling +
testing. Locked unless something forces a rethink.
