# Block Processing Fix — Correct Per-Chunk Block State

## Problem

`AudioProcessor.process()` and `EventProcessor.process()` split a block at `UpdateEvent` boundaries to interleave parameter updates with audio/event processing. Each chunk calls `processAudio(block, fromIndex, toIndex)` or `processEvents(block, from, to)` with the **same block object** — same flags, same `p0`/`p1`.

This is wrong:
- **Flags**: one-shot flags (`discontinuous`, `bpmChanged`) fire on every chunk instead of just the first
- **Musical range**: `p0`/`p1` don't match the chunk's actual time window

Processors that read `block.flags` inside `processAudio` are affected:
- `TidalDeviceProcessor` — reads `flags`, `p0`, `bpm`
- `DelayDeviceProcessor` — reads `flags`, `bpm`
- `VaporisateurDeviceProcessor` — reads `block`

Processors using `_block` (ignoring it) are safe but still receive incorrect data.

`EventProcessor` has the same issue — passes the original block to `processEvents(block, from, to)` and `handleEvent(block, event)` for every chunk.

## Solution

### 1. Mutable block copy per chunk

`AudioProcessor` and `EventProcessor` create a mutable copy of the block at the start. For each chunk, update `s0`/`s1`, `p0`/`p1`, and clear one-shot flags after the first chunk.

### 2. Remove `fromIndex`/`toIndex` from `processAudio`

The block's `s0`/`s1` already represent the chunk range — no need for separate parameters.

```typescript
// Before
abstract processAudio(block: Block, fromIndex: int, toIndex: int): void

// After
abstract processAudio(block: Block): void
```

Processors read `block.s0` and `block.s1` instead of `fromIndex`/`toIndex`.

### 3. Separate state and event flags

The current `flags` field mixes two concerns:
- **State flags**: `transporting`, `playing` — persistent across all chunks
- **Event flags**: `discontinuous`, `bpmChanged` — one-shot, valid only for the first chunk

Add a mask constant to make the contract explicit:

```typescript
export const enum BlockFlag {
    transporting = 1 << 0,
    discontinuous = 1 << 1,
    playing = 1 << 2,
    bpmChanged = 1 << 3,
}

export namespace BlockFlag {
    export const eventMask = BlockFlag.discontinuous | BlockFlag.bpmChanged
}
```

## Implementation

### AudioProcessor (after)

```typescript
export abstract class AudioProcessor extends AbstractProcessor {
    readonly #chunk: Mutable<Block> = {index: 0, p0: 0, p1: 0, s0: 0, s1: 0, bpm: 0, flags: 0}

    protected constructor(context: EngineContext) {
        super(context)
    }

    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, s0, s1, bpm} = block
            const chunk = Object.assign(this.#chunk, block)
            let anyEvents: Maybe<Array<Event>> = null
            for (const event of this.eventInput.get(index)) {
                const pulses = event.position - p0
                const toIndex = Math.abs(pulses) < 1.0e-7
                    ? s0
                    : s0 + Math.floor(PPQN.pulsesToSamples(pulses, bpm, sampleRate))
                assert(s0 <= toIndex && toIndex <= s1, () =>
                    `${toIndex} out of bounds. event: ${event.position} (${event.type}), p0: ${p0}`)
                anyEvents?.forEach(event => this.handleEvent(event))
                anyEvents = null
                if (chunk.s0 < toIndex) {
                    chunk.s1 = toIndex
                    chunk.p1 = event.position
                    this.processAudio(chunk)
                    chunk.s0 = toIndex
                    chunk.p0 = event.position
                    chunk.flags &= ~BlockFlag.eventMask
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position,
                        s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(event))
            anyEvents = null
            if (chunk.s0 < s1) {
                chunk.s1 = s1
                chunk.p1 = block.p1
                this.processAudio(chunk)
            }
        })
        this.eventInput.clear()
        this.finishProcess()
    }

    abstract processAudio(block: Block): void
    introduceBlock(_block: Block): void {}
    handleEvent(_event: Event): void {
        return panic(`${this} received an event but has no accepting method.`)
    }
    finishProcess(): void {}
}
```

### EventProcessor (after)

Same pattern — mutable copy with sliding `p0`/`p1` window and event flag clearing:

```typescript
export abstract class EventProcessor extends AbstractProcessor {
    readonly #chunk: Mutable<Block> = {index: 0, p0: 0, p1: 0, s0: 0, s1: 0, bpm: 0, flags: 0}

    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, p1, s0, bpm} = block
            const chunk = Object.assign(this.#chunk, block)
            let anyEvents: Maybe<Array<Event>> = null
            for (const event of this.eventInput.get(index)) {
                anyEvents?.forEach(event => this.handleEvent(chunk, event))
                anyEvents = null
                if (chunk.p0 < event.position) {
                    chunk.p1 = event.position
                    this.processEvents(chunk, chunk.p0, event.position)
                    chunk.p0 = event.position
                    chunk.flags &= ~BlockFlag.eventMask
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position,
                        s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(chunk, event))
            anyEvents = null
            if (chunk.p0 < p1) {
                chunk.p1 = p1
                this.processEvents(chunk, chunk.p0, p1)
            }
        })
        this.eventInput.clear()
    }

    abstract handleEvent(block: Block, event: Event): void
    abstract processEvents(block: Block, from: ppqn, to: ppqn): void
    introduceBlock(_block: Block): void {}
}
```

## Affected Processors

### Signature change: `processAudio(block)` — remove `fromIndex`/`toIndex`

All 22 implementations need updating. Most are mechanical: rename `fromIndex`→`block.s0`, `toIndex`→`block.s1`.

| Processor | Uses block? | Notes |
|-----------|-------------|-------|
| WaveshaperDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| CompressorDeviceProcessor | `_block` | Rename from/to only |
| GateDeviceProcessor | `_block` | Rename from/to only |
| MaximizerDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| CrusherDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| FoldDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| ReverbDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| DattorroReverbDeviceProcessor | `_block` | Rename from/to only |
| RevampDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| StereoToolDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| NeuralAmpDeviceProcessor | `_block` | Rename from/to only |
| ChannelStripProcessor | `_block` | Rename fromIndex/toIndex only |
| AuxSendProcessor | `_block` | Rename fromIndex/toIndex only |
| NanoDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| SoundfontDeviceProcessor | `_block` | Rename fromIndex/toIndex only |
| MIDIOutputDeviceProcessor | `_block` | No-op body |
| PlayfieldMixProcessor | `_block` | No-op body |
| PlayfieldSampleProcessor | `_block` | Rename fromIndex/toIndex only |
| **TidalDeviceProcessor** | `{p0, bpm, flags}` | **Now receives correct per-chunk values** |
| **DelayDeviceProcessor** | `{bpm, flags}` | **Now receives correct per-chunk flags** |
| **VaporisateurDeviceProcessor** | `block` | **Now receives correct per-chunk block** |
| TapeDeviceProcessor | via introduceBlock | Not affected (uses introduceBlock for flags) |

### Mutable type

Need a `Mutable<T>` utility type (remove `Readonly`). Check if `@opendaw/lib-std` already has one, otherwise add it:

```typescript
export type Mutable<T> = { -readonly [K in keyof T]: T[K] }
```
