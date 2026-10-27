# Measuring DSP load inside an AudioWorklet

Findings from openDAW, October 2026.

## Problem

openDAW shows a DSP load meter and records the render time of every 128-frame block. Developers use it while
writing plug-ins. At 48 kHz a block has a budget of 2.67 ms, so the clock needs microsecond resolution.

1. `AudioWorkletGlobalScope` has no `performance` object. Verified in Chrome 155 and Firefox 157: `typeof performance`
   is `undefined` inside the worklet.
2. This follows the specs. `AudioWorkletGlobalScope` extends `WorkletGlobalScope` and only adds `registerProcessor`,
   `currentFrame`, `currentTime`, `sampleRate`, `renderQuantumSize` and `port`. HR Time declares the `Performance`
   interface as `[Exposed=(Window,Worker)]`, so worklets are not included.
3. Exposing it is tracked in [WebAudio #2413](https://github.com/WebAudio/web-audio-api/issues/2413) (open since
   May 2020, "Priority: Soon"). The spec change is [w3c/hr-time #169](https://github.com/w3c/hr-time/pull/169)
   ("Expose Performance interface to AudioWorklet", open). The Firefox implementation is
   [bug 2001624](https://bugzilla.mozilla.org/show_bug.cgi?id=2001624), status NEW as of 2026-10-21.
4. `Date.now()` is available, because it is part of ECMAScript, but it only has millisecond resolution.
   `currentTime` / `currentFrame` only advance once per render quantum. Neither can time a single block.
5. `renderCapacity` is available in neither Chrome 155 nor Firefox 157. `playbackStats` is available in Chrome
   only and reports underruns, but it measures the whole graph, not our own process call.

## The setup we had (the handshake)

A dedicated worker provided timestamps through a `SharedArrayBuffer`.

1. The worker loops on `Atomics.wait`. On every wake it writes `performance.now()` plus the counter it is answering.
2. The worklet calls `Atomics.add` + `Atomics.notify` at the start and at the end of each `process()` call.
3. At the next block the worklet reads both timestamps and only accepts the pair if the counters show both come from
   the same block. Otherwise the block is dropped.

When the measurement was enabled, we noticed that the studio performed worse overall. We wanted to know why.

## Comparison

A standalone page with an AudioWorklet that runs a calibrated synthetic load (sine sums, about 58% of the block
budget in realtime). The handshake code is a verbatim copy of the production code. Three modes:

1. none: no probe at all
2. handshake: the setup described above
3. spin: a worker that writes `performance.now()` into a `SharedArrayBuffer` in a tight loop without waiting. The
   worklet does two plain reads per block.

In the realtime test the spinning worker also runs during the handshake mode, as a ground truth for every block.
Machine: Apple M5 (10 cores), macOS, cross-origin isolated, 48 kHz, `latencyHint: "interactive"`. Each realtime run
lasted 15 s (about 5600 blocks), two rounds per mode. Timer resolution was 5 µs in Chrome and 20 µs in Firefox.

### Chrome 155, offline (OfflineAudioContext, wall time per block, median of 5 interleaved runs)

| mode      | µs per block | Δ vs none |
|-----------|-------------:|----------:|
| none      |      1248.65 |      0.00 |
| handshake |      1248.59 |     -0.05 |
| spin      |      1252.03 |     +3.39 |

Offline rendering shows no measurable cost for any mode.

### Chrome 155, realtime (AudioContext, ground truth from the spinning clock)

| metric                                  | spin r0 | spin r1 | handshake r0 | handshake r1 |
|-----------------------------------------|--------:|--------:|-------------:|-------------:|
| block duration mean (µs)                |    1537 |    1562 |         1557 |         1580 |
| block duration p99 (µs)                 |    1625 |    1890 |         1705 |         1980 |
| block duration p99.9 (µs)               |    1640 |    2285 |         2085 |         2415 |
| underrun events (`playbackStats`)       |       0 |       0 |            1 |            1 |
| dropped pairs                           |       0 |       0 |  2801 / 5631 |  2552 / 5121 |
| dropped among the slowest 1% of blocks  |       0 |       0 |      32 / 57 |      25 / 52 |
| error vs ground truth p99 (µs)          |         |         |          170 |          360 |
| error vs ground truth p99.9 (µs)        |         |         |          790 |         1115 |

The second handshake round contains one 1.4 s callback stall that we attribute to the browser automation tool
disconnecting during the run. It does not change the dropped-pair ratio.

### Firefox 157, offline

| mode      | µs per block | Δ vs none |
|-----------|-------------:|----------:|
| none      |      1399.64 |      0.00 |
| handshake |      1404.10 |     +4.47 |
| spin      |      1418.06 |    +18.42 |

### Firefox 157, realtime

| metric                                  | spin r0 | spin r1 | handshake r0 | handshake r1 |
|-----------------------------------------|--------:|--------:|-------------:|-------------:|
| block duration mean (µs)                |    1399 |    1710 |         1723 |         1723 |
| block duration p99 (µs)                 |    1420 |    1740 |         1760 |         1760 |
| block duration p99.9 (µs)               |    1440 |    1760 |         1780 |         1760 |
| dropped pairs                           |       0 |       0 |  2811 / 5633 |  2814 / 5633 |
| dropped among the slowest 1% of blocks  |       0 |       0 |      26 / 57 |      33 / 57 |
| error vs ground truth p99 (µs)          |         |         |           60 |           60 |
| error vs ground truth p99.9 (µs)        |         |         |          460 |           60 |
| error vs ground truth max (µs)          |         |         |         1300 |           60 |

Firefox does not expose `playbackStats`, so there are no underrun counts. The first spin round ran at about 1400 µs
and every later run at about 1720 µs for the same work. We read this as a change of CPU frequency or core during the
session, not as a cost of the probe. Comparing spin r1 with the handshake rounds gives about 13 µs (0.7%) for the
handshake.

### Node microbench (same V8 Atomics, independent nanosecond clock)

The calling thread runs 1300 µs of busy work every 2667 µs, measured with `process.hrtime.bigint()`.

| mode      | probe cost per block mean | p99     | max      |
|-----------|--------------------------:|--------:|---------:|
| handshake |                   ~3.0 µs | ~7.7 µs | ~30 µs   |
| spin      |                   ~0.1 µs | ~0.6 µs | ~20 µs   |

The spinning clock reported the 1300 µs of work with a mean error under 1 µs, about 10 µs at p99 and up to
270 µs in the single worst block.

## Findings

1. The handshake itself is cheap in isolation (about 3 µs per block in node, 4 µs offline in both browsers). The
   cost appears on the realtime thread. In Chrome it adds about 20 µs per block on average, noticeably fatter tails
   and one underrun per 15 s run. In Firefox it adds about 13 µs per block.
2. Half of all blocks are never measured, in both browsers (50% in Chrome, 50% in Firefox). Both often render
   quanta back to back. The gap between the end of one block and the start of the next is shorter than the time the
   waiting worker needs to wake up and answer, so the pair check fails.
3. The drops are biased towards the slowest blocks. In Chrome 25 to 32, in Firefox 26 to 33 of the slowest ~55
   blocks were missing, which means a load meter built on the handshake under-reports exactly the spikes it should
   catch.
4. The pairs that are accepted carry the worker's wake-up delay. In Chrome the error reaches 0.8 to 1.1 ms at
   p99.9, on a 2.67 ms budget. Firefox is tighter (60 µs at p99) but still had a single 1.3 ms outlier.
5. Our guess for the realtime cost is the wake path: two `futex` wakes per block from a high-priority thread, and
   possibly lock contention in the engine's `Atomics.wait` / `notify` implementation with a normal-priority worker.
   We did not verify this in the V8 or SpiderMonkey source.
6. The spinning clock is not free either. Offline it costs 3 µs per block in Chrome and 18 µs (1.3%) in Firefox,
   presumably because the busy core competes for shared resources with the render thread.

## What we ship now

1. A worker spins `performance.now()` into an 8-byte `SharedArrayBuffer`. It only runs while the user enables the
   measurement and is terminated when the measurement is switched off.
2. The worklet reads the value at the start and the end of `process()`. No atomics, no syscalls, no dropped pairs.
3. A block whose two reads are identical is not recorded, because the spinning worker was descheduled during it.
4. On machines with fewer than 4 logical cores the worker is not started, because it would compete with the audio
   thread.
5. Cost: one busy core while measuring. That is acceptable for a developer tool but not for an always-on meter.

## Open questions

1. What is blocking hr-time #169 and bug 2001624? With `performance.now()` in the worklet (cross-origin isolated,
   20 µs in Firefox according to #2413) we could drop the spinning worker entirely.
2. What is the status of `AudioContext.renderCapacity` and `playbackStats` in Firefox? They would give us a
   zero-cost overall load figure, even if not per process call.
3. Is there a cheaper way to get per-block timing without a spinning core?
4. Does the Firefox wake path for `Atomics.notify` from the audio thread explain the dropped pairs we see, or is
   there a pattern we should use instead?
