# Plan: High-Resolution Clock for AudioWorklet & Buffer Underrun Detection

## Problem
- AudioWorklet scope has no access to `performance.now()` (high-resolution timing)
- `Date.now()` has only 1ms resolution, insufficient for precise audio timing
- Buffer underrun detection is difficult without accurate timing
- When NAM WASM instances overload CPU, audio stops but no error is thrown
- Detection from main thread doesn't work reliably when audio thread is overloaded

## Solution: Worker-Based High-Resolution Clock

Paul Adenot (Mozilla, Web Audio API architect) suggested this approach:

### Concept
1. Create a Web Worker on main thread (Workers have `performance.now()`)
2. Share a `SharedArrayBuffer` between Worker and AudioWorklet
3. Worker blocks with `Atomics.wait()` waiting for signal
4. AudioWorklet signals via `Atomics.notify()` when it needs a timestamp
5. Worker wakes, writes `performance.now()` to the buffer, blocks again
6. AudioWorklet reads the high-resolution timestamp

### Why Better Than Date.now()

| | `Date.now()` | `performance.now()` |
|---|---|---|
| **Resolution** | ~1ms | ~0.001ms (microseconds) |
| **Monotonic** | No (can jump due to NTP/clock sync) | Yes (guaranteed) |
| **Precision** | System clock based | High-resolution timer |

For audio at 48kHz:
- 1 sample = ~0.02ms
- 1 render quantum (128 samples) = ~2.67ms
- `Date.now()` with 1ms resolution may miss subtle timing issues

### SharedArrayBuffer Layout (32 bytes)
```
int32[0]: request counter (AudioWorklet increments on each signal)
int32[1]: start response counter (which request the start timestamp is for)
int32[2]: end response counter (which request the end timestamp is for)
float64[2]: start timestamp (bytes 16-23)
float64[3]: end timestamp (bytes 24-31)
```

### Signal-Based Flow
1. Worker blocks: `Atomics.wait(sab, 0, lastSeenRequest)`
2. AudioWorklet signals start: `Atomics.add(sab, 0, 1)` (counter becomes odd)
3. Worker wakes, writes timestamp to start slot + stores counter in int32[1]
4. AudioWorklet does processing...
5. AudioWorklet signals end: `Atomics.add(sab, 0, 1)` (counter becomes even)
6. Worker wakes, writes timestamp to end slot + stores counter in int32[2]

### Key Insight: Counter Validation
The critical problem with async timestamps is that reads are always stale. If the
worker falls behind, we might read mismatched timestamps (start from render N-3,
end from render N-2), producing garbage values.

**Solution**: Worker writes both timestamp AND counter. HRClock validates that
`endCounter === startCounter + 1` before using the measurement. Invalid pairs
are dropped (return 0) rather than producing false spikes.

## Implementation Files

### `packages/studio/core/src/HRClockWorker.ts`
Singleton Worker with inline script (Blob URL). Writes to separate slots based on counter parity.
```typescript
// Worker writes to slot based on odd/even counter
const isStart = (lastCounter & 1) === 1
if (isStart) {
    float64[2] = performance.now()
    Atomics.store(int32, 1, lastCounter)  // Store which request this is for
} else {
    float64[3] = performance.now()
    Atomics.store(int32, 2, lastCounter)
}
```

### `packages/studio/core-processors/src/HRClock.ts`
AudioWorklet side. Validates counter pairs before using measurements.
```typescript
start(): number {
    // Read response counters and timestamps
    const startCounter = Atomics.load(this.#int32View, 1)
    const endCounter = Atomics.load(this.#int32View, 2)
    const startTs = this.#float64View[2]
    const endTs = this.#float64View[3]
    // Signal for new start timestamp
    this.#signal()
    // Only use if counters indicate a valid pair from same render
    let elapsed = 0
    if (this.#prevStartCounter > 0 && this.#prevEndCounter === this.#prevStartCounter + 1) {
        elapsed = this.#prevEndTs - this.#prevStartTs
    }
    // Store for next frame
    this.#prevStartCounter = startCounter
    this.#prevEndCounter = endCounter
    this.#prevStartTs = startTs
    this.#prevEndTs = endTs
    return elapsed
}

end(): void {
    this.#signal()  // Signal for end timestamp
}
```

## Usage in EngineProcessor
```typescript
render(): boolean {
    const elapsed = this.#hrClock.start()  // Returns elapsed of PREVIOUS render
    // ... processing ...
    this.#hrClock.end()
    this.#perfBuffer[this.#perfWriteIndex] = elapsed
    this.#perfWriteIndex = (this.#perfWriteIndex + 1) % PERF_BUFFER_SIZE
}
```

## Issues Encountered

1. **Reads are always stale**: When we signal the worker and immediately read, we get the
   timestamp from a PREVIOUS signal, not the current one. This is fundamental to the async nature.

2. **Worker thread starvation**: With empty/light projects, the audio thread runs so fast
   that the worker doesn't get scheduled between signals. Multiple signals queue up before
   the worker responds.

3. **Mismatched timestamps cause spikes**: If we read start from signal N-3 and end from
   signal N-2, the elapsed time is garbage. This caused false red spikes in the display.

4. **Solution: Counter validation**: By having the worker write which counter value each
   timestamp corresponds to, we can verify that start/end are from the same render.
   Invalid pairs are dropped (return 0) instead of showing false data.

## Future
Paul mentioned there's discussion about adding `performance.now()` or similar high-resolution timing to AudioWorkletGlobalScope directly.

## References
- Paul Adenot (Mozilla) - Web Audio API architect
- SharedArrayBuffer + Atomics for cross-thread communication
