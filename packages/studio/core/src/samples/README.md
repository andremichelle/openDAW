# Sample Loading Architecture

## Overview

This module implements a global sample loading system that enables **zero-copy sharing** of audio data across multiple projects using `SharedArrayBuffer`.

## Key Design Goals

1. **Memory Efficiency**: Same audio sample loaded once, shared across all projects
2. **SharedArrayBuffer**: Audio data uses SAB for zero-copy transfer to audio worklet
3. **Separation of Concerns**: Clear distinction between state management and loading orchestration
4. **Reference Counting**: Samples released only when no project references them

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  GlobalSampleLoaderManager (singleton per openDAW instance)     │
│                                                                 │
│  Responsibilities:                                              │
│  - Global cache of AudioData (SharedArrayBuffer)                │
│  - Reference counting per sample UUID                           │
│  - Loading orchestration (cache → OPFS → API)                   │
│  - Lifecycle management (register/unregister)                   │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   #cache    │  │ #refCounts  │  │  #loaders   │              │
│  │ SortedSet<  │  │ SortedSet<  │  │ SortedSet<  │              │
│  │ CachedSample>│  │ RefCount>   │  │ Loader>     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ creates & manages
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  DefaultSampleLoader (one per sample UUID)                      │
│                                                                 │
│  Responsibilities:                                              │
│  - Hold sample state (data, peaks, meta, loading state)         │
│  - Notify subscribers of state changes                          │
│                                                                 │
│  NO knowledge of: cache, storage, API, loading logic            │
└─────────────────────────────────────────────────────────────────┘
```

## Loading Flow

```
getOrCreate(uuid)
    │
    ├── Loader exists? → return existing
    │
    └── Create new DefaultSampleLoader
            │
            └── #load(loader)
                    │
                    ├── 1. Check #cache
                    │       └── HIT → loader.setLoaded() ─────────────────┐
                    │                                                     │
                    ├── 2. Try SampleStorage (OPFS)                       │
                    │       └── SUCCESS → cache + loader.setLoaded() ─────┤
                    │                                                     │
                    └── 3. Fetch from API                                 │
                            └── SUCCESS → save to OPFS                    │
                                       → cache                            │
                                       → loader.setLoaded() ──────────────┘
                                                                          │
                                                              Sample ready ▼
```

## Reference Counting

Projects register interest via `register(uuid)` which returns a `Terminable`:

```typescript
// In AudioFileBoxAdapter
constructor() {
    // Register interest, get back a Terminable
    this.#terminator.own(this.#context.sampleManager.register(uuid))
}

// When adapter is terminated, the Terminable auto-unregisters
terminate(): void {
    this.#terminator.terminate() // decrements ref count
}
```

When ref count reaches 0:
- Loader removed from `#loaders`
- Cached sample removed from `#cache`
- SharedArrayBuffer eligible for garbage collection

## Multi-Project Scenario

```
Project A                          Project B
    │                                  │
    ├── register(sample-X) ───────────┤── register(sample-X)
    │   refCount[X] = 1               │   refCount[X] = 2
    │                                  │
    ├── getOrCreate(sample-X)          │
    │   └── #load() → cache miss       │
    │       └── SampleStorage.load()   │
    │           └── cache[X] = data    │
    │                                  │
    │                                  ├── getOrCreate(sample-X)
    │                                  │   └── #load() → CACHE HIT!
    │                                  │       └── Same AudioData (SAB)
    │                                  │
    ├── close project                  │
    │   └── unregister(sample-X)       │
    │       refCount[X] = 1            │
    │       (loader & cache preserved) │
    │                                  │
                                       ├── close project
                                       │   └── unregister(sample-X)
                                       │       refCount[X] = 0
                                       │       └── Remove loader
                                       │       └── Remove from cache
                                       │       └── SAB can be GC'd
```

## Files

| File | Purpose |
|------|---------|
| `GlobalSampleLoaderManager.ts` | Loading orchestration, caching, ref counting |
| `DefaultSampleLoader.ts` | State holder, subscriber notifications |
| `SampleStorage.ts` | OPFS persistence (read/write WAV files) |
| `SampleProvider.ts` | Interface for fetching from API |
| `OpenSampleAPI.ts` | API client implementation |

## AudioData & SharedArrayBuffer

Audio samples use `SharedArrayBuffer` for zero-copy sharing between main thread and audio worklet:

```typescript
// In @opendaw/lib-dsp
type AudioData = {
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
    frames: ReadonlyArray<Float32Array<SharedArrayBuffer>>
}

// Created via factory that allocates SAB
AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
```

The same `AudioData` instance (and its underlying SAB) is shared:
- Across multiple projects using the same sample
- Between main thread and audio worklet (via postMessage, SAB auto-shared)

## Key Invariants

1. One `DefaultSampleLoader` per UUID (managed by `GlobalSampleLoaderManager`)
2. One `CachedSample` per UUID in `#cache`
3. `refCount > 0` → loader and cache entry exist
4. `refCount === 0` → loader and cache entry removed
5. `DefaultSampleLoader` never accesses storage/API directly
