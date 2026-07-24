# Optimise Sample-Streaming Memory Reads

## Status

Superseded 2026-05-06 by the cross-platform data captured via `/performance/sample-read`. Block-copy regresses on Mac, Linux/Chromium, and Linux/Firefox. **Do not implement.**

The original "Plan only" rationale (drafted 2026-05-01 from `/performance` data captured 2026-04-30) is preserved below for historical context.

## Findings (cross-platform bench, 2026-05-05)

A self-contained benchmark page (`/performance/sample-read`, source on `main` from commit `a67dcd17 adds optimisation test`) runs both kernels — `direct` (the current `SampleVoice.processAdd` shape) and `blockcopy` (the proposal below) — across a sweep of sample sizes (50 KB / 3.84 MB / 16 MB), pitch rates (0.5× / 1× / 2× / 4×), and voice counts (1 / 2 / 4), on the main thread and inside a Web Worker. Each measurement is best-of-7 after warmup, calibrated to ~50 ms per timed run.

Block-copy regresses on every platform tested, including Linux/Chromium — the platform this plan was meant to help.

| Platform | main thread Δ time % (geomean) | worker thread Δ time % (geomean) | wins / losses |
|---|---|---|---|
| Mac M-series, Chrome 147 | **+27.6 %** | **+27.8 %** | 0 / 13 each |
| Linux x86_64, Firefox 149 | **+4.4 %** | **+6.1 %** | 0 / 3 each |
| Linux x86_64, Chromium 147 | **+23.8 %** | **+26.0 %** | 0 / 13 each |

Direct-read cost is essentially flat across sample sizes. If reads were dominated by cache misses, ns/sample would scale with working-set size; it does not:

| Platform | direct ns/sample (range across 50 KB → 16 MB) |
|---|---|
| Mac M-series | 1.80 – 1.94 |
| Linux Firefox 149 | 9.08 – 10.08 |
| Linux Chromium 147 | 8.08 – 9.35 |

### Interpretation

The hot loop is **compute-bound on every platform**, not memory-bound. The Linux/Chromium ~4.6× gap vs Mac is engine cost (FMA + interpolation + envelope + branches), not DRAM traffic. Block-copy adds ~1–2 ns/sample of memcpy + bookkeeping overhead and removes nothing useful. Higher pitch rates (4×, larger windows) make the regression worse, not better — opposite of what this plan predicted.

The Linux/Chromium glitch report that motivated this investigation is therefore **not** a memory-bandwidth problem. A separate plan, driven by separate evidence (profiling the non-read parts of `processAdd`, scheduler/RT-priority on Linux, etc.), is needed to address it.

## Background

A user on Linux/Chromium reported glitches running a project with three SoundFont instances. Initial hypothesis was that SharedArrayBuffer reads might be slower on Chromium/Linux.

The `/performance` page was extended with memory micro-benchmarks comparing `Float32Array` reads backed by `ArrayBuffer` vs `SharedArrayBuffer`, on the main thread and inside a Web Worker, across sequential, random, and linear-interpolation patterns at 1 MB and 32 MB.

### What the data showed

**SAB is not the issue.** AB and SAB perform within 1-3% of each other across every test, every browser, every thread context. Don't file a Chromium bug. SAB is not slower than AB on Linux.

**The hardware is the issue.** Random reads on the user's Linux box are ~6x slower than on a Mac, sequential reads ~2x slower:

| Test | Mac main | Linux Chromium main | Linux Firefox main |
|------|----------|--------------------|--------------------|
| Seq 1 MB AB | 0.59 ns/op | 1.19 ns/op | 1.49 ns/op |
| Seq 32 MB AB | 0.59 ns/op | 1.31 ns/op | 1.58 ns/op |
| Random 32 MB AB | 2.08 ns/op | 11.90 ns/op | 14.63 ns/op |
| Interp 32 MB AB | 0.73 ns/op | 4.04 ns/op | 4.44 ns/op |

That ~6x random-read penalty is the entire reason sample-streaming devices feel heavier on slower x86 boxes. It's cache and TLB pressure, not browser engine cost.

**Worker context overhead is negligible on Chromium**, slightly meaningful on Firefox at very small working sets, but irrelevant for actual DSP workloads.

### Per-device cost on the user's Linux Chromium

| Device | µs/quantum |
|--------|-----------|
| Vocoder | 42.92 |
| Fold | 42.33 |
| Playfield | 28.94 |
| Tape | 27.92 |
| Reverb / Dattorro | ~25 |
| Vaporisateur | 19.32 |
| Soundfont | 2.15 |

Soundfont being so much cheaper than Playfield prompted closer inspection. Both devices do linear-interpolation reads on a `Float32Array` (or `Int16Array`). Why the 13x gap?

### Why Soundfont is cheap and Playfield is not

Reading the actual hot loops:

| Property | SoundfontVoice | PlayfieldSampleVoice |
|----------|----------------|---------------------|
| Sample storage type | `Int16Array` | `Float32Array` |
| Bytes per element | 2 | 4 |
| Channels read per output sample | 1 (mono, panned) | 2 (true stereo) |
| Reads per output sample | 2 + 1 envBuffer | 4 |
| Sample size in benchmark | ~50-200 KB (one SF2 zone) | 3.84 MB (10 s × 48 kHz × 2 ch × 4 B) |
| Hot working set per voice | ~50 KB | ~3.84 MB |

The per-voice working set is roughly 80x larger for Playfield. SoundFont's voices are small enough to be L1/L2 resident; Playfield's voices don't fit in L3 once two are alive. Combined with 2x the typed-array reads per output sample, 13x total overhead is what we'd expect.

The "memory access pattern is similar" claim is true at a high level. The constants differ by factors of 2 (channel count, bytes per element) and 38 (sample size), and they multiply.

## Original proposal (obsolete — see Findings)

The block-copy proposal below was drafted before the bench data arrived. It was rejected by `/performance/sample-read` on three platforms; the text remains so the historical reasoning is on record.

### Idea

Once per voice per quantum, copy the source sample window the inner loop will read into a small Float32Array that lives in L1 cache. Run interpolation against the local buffer instead of the giant source array.

### Code sketch

Current `Playfield/SampleVoice.ts:77` inner loop reads `inpL[intPosition]` and `inpR[intPosition]` (with their `+1` neighbours) directly from `this.#data.frames[0/1]`. Replace with:

```ts
processAdd(output, fromIndex, toIndex) {
    const span = toIndex - fromIndex
    const samplesNeeded = Math.ceil(span * Math.abs(rateRatio)) + 2
    const startInt = this.#position | 0
    // Copy contiguous window once into stack-local typed arrays:
    const localL = this.#localL ??= new Float32Array(MAX_QUANTUM_SPAN)
    const localR = this.#localR ??= new Float32Array(MAX_QUANTUM_SPAN)
    localL.set(inpL.subarray(startInt, startInt + samplesNeeded))
    localR.set(inpR.subarray(startInt, startInt + samplesNeeded))
    let localPos = this.#position - startInt
    for (let i = fromIndex; i < toIndex; i++) {
        const intPos = localPos | 0
        const frac = localPos - intPos
        const l = localL[intPos] * (1.0 - frac) + localL[intPos + 1] * frac
        const r = localR[intPos] * (1.0 - frac) + localR[intPos + 1] * frac
        // ... envelope, gate logic unchanged ...
        outL[i] += l * env
        outR[i] += r * env
        localPos += rateRatio
    }
    this.#position = startInt + localPos
}
```

The interpolation maths, the variable rate, the envelope, the gate and loop logic stay exactly the same. The only thing that changes is which array the inner loop reads from.

### Why this is faster

1. **Bulk copy is vectorised.** `dst.set(src.subarray(...))` becomes a SIMD memcpy. Copying 1-2 KB costs ~50-100 ns total, regardless of where in the source array the slice lives.
2. **Inner loop hits L1.** After the copy, the local buffer is guaranteed cache-resident. Each read costs ~1 ns instead of ~12 ns from DRAM.
3. **TLB pressure collapses.** Multiple simultaneous voices spanning a 3.84 MB array touch many 4 KB pages. After block-copy, each voice's reads hit one page.

### Predicted gain

For one voice at 1x rate, 128 output samples on the user's Linux box:

- **Current**: 4 reads × 128 outputs = 512 random reads × 12 ns ≈ 6.1 µs per voice per quantum.
- **With block copy**: one ~1.5 KB memcpy (~80 ns) + 512 L1 reads × 1 ns ≈ 600 ns per voice per quantum.

About a 10x improvement per voice. With one or two voices alive in the benchmark, Playfield should drop from ~29 µs/q to ~3-5 µs/q on his hardware. Mac numbers won't change much, since the source array already lives in L2 there.

### Edge cases

- **Pitch rate so high the span exceeds the local buffer.** At 50x rate the local buffer would be ~76 KB. Still fits in L2. Need a sensibly sized cap (`MAX_QUANTUM_SPAN`, say 4096 elements = 16 KB) or compute the buffer size dynamically per voice.
- **Loop crossing within a quantum.** When `Gate.Loop` wraps `position` from `loopEnd` to `loopStart` mid-quantum, the local buffer must contain both the tail near `loopEnd` and the head near `loopStart`. Two-segment copy, or fall back to direct reads near the boundary (typically <1% of quanta).
- **Reverse playback (negative `rateRatio`).** Same idea, copy a window that ends at `position` and starts `samplesNeeded` before. The loop direction inside the local buffer is unchanged.
- **End-of-sample detection.** The current `if (this.#position >= numberOfFrames) return true` check still needs the absolute source position, not the local position. Track both.

## Plan: Don't optimise Soundfont yet

SoundfontVoice already runs against small `Int16Array` zones that fit in L1/L2. Block-copy would add work without removing many cache misses. Probably wash, possibly slight regression. Revisit only if real-world projects with many simultaneous SoundFont voices show the device becoming a bottleneck.

## Plan: Don't change sample storage format

Switching Playfield's sample storage from `Float32Array` to `Int16Array` (matching SoundFont) would halve the working set on top of the block-copy gain. Bigger refactor: storage paths, sample loading, possibly the AudioData type. Defer until block-copy is merged and we have updated numbers from the user's hardware.

## Original implementation steps (do not implement — see Findings)

1. Add a `MAX_QUANTUM_SPAN` constant in `Playfield/SampleVoice.ts` sized for typical max pitch ratios, with a runtime check for safety.
2. Allocate `#localL` and `#localR` as `Float32Array(MAX_QUANTUM_SPAN)` lazily on first call (or eagerly in constructor).
3. Compute `samplesNeeded` from current `rateRatio` and `toIndex - fromIndex`.
4. Copy `inpL.subarray(startInt, startInt + samplesNeeded)` into `#localL`, same for R, before the inner loop.
5. Rebase `position` into local-buffer space, run inner loop reading from local buffers, write final position back.
6. Handle Loop case: if the read window crosses `#end`, do two `set()` calls or fall back to direct reads.
7. Verify with `/performance` on Mac (should be ~unchanged) and on the Linux user's box (should drop substantially).

## Open questions (resolved)

- **"Predicted Linux gain assumes random reads are the bottleneck."** → **Empirically false.** Direct-read ns/sample is flat across sample sizes from 50 KB to 16 MB on every platform tested. The hot loop is compute-bound. The "other major contributors" the question hedges against are in fact the dominant cost — `processAdd`'s envelope state, the three `Gate` branches, parameter smoothing, and the output-buffer writes are where Playfield's 28 µs/quantum lives, not in the read path.
- **"Source slicing creates a new typed-array view per `subarray()` call."** → **Moot.** The proposal isn't shipping; the question is academic. The bench did not isolate this overhead, but it's plausibly part of the ~1–2 ns/sample of bookkeeping that `blockcopy` paid on top of `direct` and never recouped.
- **"The user's actual project is the truth, not the benchmark."** → **Still true, but doesn't apply here.** The benchmark cleanly disproved the memory-bound hypothesis on three platforms; running the user's project would not have rescued a kernel that regresses by +24% on the very target hardware. The user's glitch report stands and needs a fresh investigation in a separate plan.

## What this plan does not address

- Audio worklet RT priority on Linux/Chromium ([crbug 813825](https://bugs.chromium.org/p/chromium/issues/detail?id=813825)). Out of our hands.
- PulseAudio vs PipeWire scheduling. Suggest user-side, not a code change.
- Firefox vs Chromium offline render parity. Both browsers are roughly equivalent in offline measurement; the live audio thread is where they diverge, and that's a scheduling concern outside the scope of this plan.
