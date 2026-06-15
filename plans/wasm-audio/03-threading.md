# 03 — Threading model

## Decision: single-threaded

All DSP runs inline in the AudioWorklet, on one thread. No worker fan-out.

## The real constraint

Two facts make real-time multithreading unworkable, regardless of how the graph is split:

- The worklet `process()` runs on the real-time audio thread and **cannot wait** for a worker — no
  blocking, no `await`, no `Atomics.wait`; it must return a quantum every callback.
- Workers **cannot be prioritized** (best-effort scheduled), so a worker's result may arrive *after*
  the worklet already needed it.

Independent **subgraphs** exist and would be cheap to parallelize — but that changes nothing: the
worklet still can't wait for the worker subgraph, and the worker can't be guaranteed to finish in
time. So everything is computed inline.

Bonus: single-threaded is deterministic, which keeps parity tests vs the TS engine reproducible.

## Notes

- Top runtime performance is **not** a goal — nothing pushes us toward MT anyway.
- Offline rendering is **out of scope**.
