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

### SharedArrayBuffer Layout
```
[0] = request counter (AudioWorklet increments to request)
[1-2] = timestamp (Float64 for performance.now())
[3] = response counter (Worker increments after writing)
```

### Signal-Based Flow
1. Worker blocks: `Atomics.wait(sab, 0, lastSeenRequest)`
2. AudioWorklet needs time: `Atomics.add(sab, 0, 1)` + `Atomics.notify(sab, 0)`
3. Worker wakes, writes `performance.now()` as Float64 to `[1-2]`, increments `[3]`
4. Worker blocks again on new request counter value
5. AudioWorklet reads timestamp from `[1-2]`

### Alternative: 1ms Polling (Simpler but less precise)
Paul noted: "if your app already has a poll loop, 1ms polling might be fine"

But this provides no benefit over `Date.now()` - same ~1ms resolution with extra Worker complexity.

## Implementation Files

### `packages/studio/core/src/HRClockWorker.ts`
```typescript
// Main thread: creates Worker + SharedArrayBuffer
export class HRClockWorker {
    readonly sab: SharedArrayBuffer
    readonly worker: Worker

    constructor() {
        this.sab = new SharedArrayBuffer(32) // enough for atomics + float64
        this.worker = new Worker(new URL('./hr-clock-worker.js', import.meta.url))
        this.worker.postMessage({sab: this.sab})
    }

    terminate(): void {
        this.worker.terminate()
    }
}
```

### `packages/studio/core/src/hr-clock-worker.ts`
```typescript
// Worker script - provides high-res timestamps on demand
let sab: SharedArrayBuffer
let int32View: Int32Array
let float64View: Float64Array

self.onmessage = (event: MessageEvent<{sab: SharedArrayBuffer}>) => {
    sab = event.data.sab
    int32View = new Int32Array(sab)
    float64View = new Float64Array(sab)

    let lastRequest = 0
    while (true) {
        // Wait for request (blocks until signaled)
        Atomics.wait(int32View, 0, lastRequest)
        lastRequest = Atomics.load(int32View, 0)

        // Write high-resolution timestamp
        float64View[1] = performance.now()

        // Signal completion
        Atomics.add(int32View, 2, 1)
        Atomics.notify(int32View, 2)
    }
}
```

### `packages/studio/core-processors/src/HRClock.ts`
```typescript
// AudioWorklet side: requests and reads timestamps
export class HRClock {
    readonly #int32View: Int32Array
    readonly #float64View: Float64Array

    constructor(sab: SharedArrayBuffer) {
        this.#int32View = new Int32Array(sab)
        this.#float64View = new Float64Array(sab)
    }

    now(): number {
        // Request timestamp
        Atomics.add(this.#int32View, 0, 1)
        Atomics.notify(this.#int32View, 0)

        // Wait for response (with timeout)
        const lastResponse = Atomics.load(this.#int32View, 2)
        Atomics.wait(this.#int32View, 2, lastResponse, 10) // 10ms timeout

        // Read timestamp
        return this.#float64View[1]
    }
}
```

## Buffer Underrun Detection Strategy

### Using High-Resolution Clock
```typescript
// In EngineProcessor
#checkUnderrun(): void {
    const now = this.#hrClock.now()
    if (this.#lastCheckTime > 0) {
        const elapsed = now - this.#lastCheckTime
        const expectedMs = (RenderQuantum / sampleRate) * 1000

        // If we took significantly longer than expected
        if (elapsed > expectedMs * 1.5) {
            this.#underrunCount++
            if (this.#underrunCount >= 10) {
                // Signal underrun via SharedArrayBuffer
                Atomics.store(this.#controlFlags, 1, 1)
            }
        } else {
            this.#underrunCount = 0
        }
    }
    this.#lastCheckTime = now
}
```

### Main Thread Detection via SharedArrayBuffer Polling
```typescript
// In EngineWorklet constructor
const underrunPollInterval = setInterval(() => {
    if (Atomics.load(this.#controlFlags, 1) === 1) {
        clearInterval(underrunPollInterval)
        this.#notifyUnderrun.notify()
    }
}, 100)
```

## Issues Encountered

1. **MessagePort callbacks don't fire under load**: When audio thread overloads CPU, main thread event loop is starved. MessagePort messages are queued but callbacks don't execute until console opens (changes Chrome scheduling).

2. **setInterval polling works better**: Independent of event loop, fires reliably.

3. **Date.now() resolution**: 1ms is too coarse for short measurement windows. Need to measure over longer periods (64+ blocks = ~170ms) for reliable detection.

## Future
Paul mentioned there's discussion about adding `performance.now()` or similar high-resolution timing to AudioWorkletGlobalScope directly.

## References
- Paul Adenot (Mozilla) - Web Audio API architect
- SharedArrayBuffer + Atomics for cross-thread communication
