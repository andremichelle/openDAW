# Inference (ONNX Runtime) Package

## Status

Plan only. Drafted 2026-05-07.

Self-contained package proposal for in-browser ML inference. Studio loads
the package and the engine lazily, on first use of any task. Not part of
the public SDK in v1; lives alongside the studio app and is consumed via
dynamic import.

## Goal

A single small package that exposes one promise-based API:

```ts
const result = await Inference.run("stem-separation", input, {progress})
```

The first call triggers, in order: dynamic import of the package itself,
dynamic import of `onnxruntime-web`, OPFS-cached download of the task's
ONNX model, session creation, inference in a Worker, return of typed
results. Subsequent calls reuse everything still in memory and only pay
the inference cost.

Tasks are defined in a registry: each task declares its model URL, hash,
pre/post-processing, and execution-provider preferences. Adding a new
task is a registry entry plus two pure functions.

## Non-goals

- Public SDK surface. The package is consumed directly by the studio.
  Promoting to SDK comes later, once the API has settled.
- Per-feature packaging. One package handles all tasks; tasks register
  themselves at module load and are tree-shaken if their entry never
  imports.
- Cloud inference. Everything runs in the browser.

## Package

Name: **`@opendaw/lib-inference`**.

Reasoning: capability-named (not engine-named) so swapping ORT for WebNN
or Transformers.js later is a non-breaking implementation detail. The
package is the abstraction; `onnxruntime-web` is the v1 engine.

Location: `packages/lib/inference/`. Mirrors the existing `lib-*` layout.

License: LGPL-3.0-or-later, matching the rest of the lib packages.

Bundle posture: `"sideEffects": false`. Tree-shakeable. ORT-Web is a
peer dependency that the package imports dynamically, so consumers
that never call any task pay zero bytes.

## Public API

One namespace, two entry points.

```ts
// packages/lib/inference/src/index.ts

export namespace Inference {
    // Convenience: load + run + dispose. Use for one-shot calls.
    export function run<K extends TaskKey>(
        task: K,
        input: TaskInput<K>,
        options?: RunOptions
    ): Promise<TaskOutput<K>>

    // For repeated calls or streaming: get a handle, call run() multiple
    // times, terminate when done.
    export function acquire<K extends TaskKey>(task: K): Promise<TaskHandle<K>>
}

export interface RunOptions {
    readonly progress?: Procedure<unitValue>   // 0..1, covers download + inference
    readonly signal?: AbortSignal              // cancellable
    readonly executionProvider?: "webgpu" | "wasm" | "auto"
}

export interface TaskHandle<K extends TaskKey> extends Terminable {
    run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>>
}
```

`TaskKey`, `TaskInput<K>`, `TaskOutput<K>` are derived from the registry
so the API is fully typed at the call site:

```ts
const stems = await Inference.run("stem-separation",
    {audio: float32, sampleRate: 44100})
// stems: {drums: Float32Array, bass: Float32Array, other: Float32Array, vocals: Float32Array}

const handle = await Inference.acquire("pitch-estimation")
const a = await handle.run(buf1)
const b = await handle.run(buf2)
handle.terminate()
```

## Task registry

Each task declares its config in one file. The registry is the union of
those files.

```ts
// packages/lib/inference/src/tasks/StemSeparationTask.ts

export const StemSeparationTask = defineTask({
    key: "stem-separation",
    model: {
        url: "https://assets.opendaw.studio/models/htdemucs/v4/htdemucs.onnx",
        sha256: "<digest>",
        bytes: 80_000_000,
        version: "v4"
    },
    executionProviders: ["webgpu", "wasm"],
    preprocess(input: {audio: Float32Array, sampleRate: number}): Tensors {...},
    postprocess(tensors: Tensors): StemSeparationOutput {...}
})
```

```ts
// packages/lib/inference/src/registry.ts

import {StemSeparationTask} from "./tasks/StemSeparationTask"
import {PitchEstimationTask} from "./tasks/PitchEstimationTask"

export const TaskRegistry = {
    "stem-separation":  StemSeparationTask,
    "pitch-estimation": PitchEstimationTask
} as const

export type TaskKey = keyof typeof TaskRegistry
```

Adding a task: drop a file under `tasks/`, register the key. No other
edits.

## OPFS layout

```
opfs/
└── inference/
    └── models/
        └── htdemucs/
            └── v4/
                ├── htdemucs.onnx       // the model bytes
                └── meta.json           // {sha256, bytes, downloadedAt, version}
```

Cache-key is `(taskKey, model.version)`. Bumping a task's `model.version`
forces a fresh download; the old version stays on disk until a future
cleanup pass collects it (out of scope for v1).

Verification: read `meta.json`, compare `sha256` against the registry.
If missing or mismatched, re-download. The hash check defends against
truncated downloads and against silent CDN drift.

## Lifecycle for one `Inference.run(task, ...)` call

```
1. Studio calls Inference.run("stem-separation", input)
   ↓
2. Inference.run dynamically imports the package itself
   (no-op on subsequent calls; module cache hit)
   ↓
3. Look up "stem-separation" in TaskRegistry
   ↓
4. ModelStore.ensure(task)
   ├── If OPFS hit + sha256 match: skip
   └── Else: fetch with progress, write to OPFS, write meta.json
   ↓
5. EngineHost.session(task)
   ├── Spawns inference Worker if not already running
   ├── Worker dynamic-imports onnxruntime-web (one-time)
   ├── Worker creates an ort.InferenceSession from the OPFS bytes
   └── Returns a session handle (cached per-task in the worker)
   ↓
6. preprocess(input) → tensors
   ↓
7. Worker: session.run(tensors) → output tensors
   ↓
8. postprocess(tensors) → typed result
   ↓
9. Resolve the promise with the result
```

`acquire(task)` exposes step 5's handle so step 6-9 can repeat without
re-creating the session.

Progress reporting fans in: download progress (0-50% of the unit value
on first run, 0% on cache hit) plus inference progress (50-100%, or
0-100% when cached). The exact split is a config knob per task.

## Worker isolation

Inference runs in a dedicated Worker spawned by the package on first
use. Reasons:

- Keeps the audio thread and UI responsive during the 30-90s of
  inference work.
- ORT-Web's WASM threads need a SAB-isolated context anyway; running in
  a Worker is the natural fit.
- Lets the package own its ORT session lifecycle independent of the
  studio's Workers.

Worker shape:

```ts
// packages/lib/inference/src/workers/inference.worker.ts

self.onmessage = async (event) => {
    const {kind, taskKey, payload} = event.data
    switch (kind) {
        case "load":   /* import ORT, build InferenceSession */ break
        case "run":    /* session.run, post results */          break
        case "release":/* drop session */                       break
    }
}
```

Communication: standard `postMessage` with structured-clone. Float32Array
buffers can be transferred (`Transferable`) when the result no longer
needs to share with the worker, which avoids copies on the way back.

## Engine-provider selection

Order: WebGPU → WASM (multi-threaded SIMD) → WASM (single-threaded SIMD).

```ts
const provider = options.executionProvider ?? task.executionProviders[0]
const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [provider, "wasm"]
})
```

ORT-Web handles fallback internally if the requested provider fails to
initialize. Tasks can pin themselves to `["wasm"]` if WebGPU support for
their operator set is incomplete.

## Initial registry contents (v1 ships with these)

| Key | Model | Size | Use case |
|---|---|---|---|
| `stem-separation` | htdemucs v4 (Demucs Hybrid Transformer) | ~80 MB | 4-stem split |
| `pitch-estimation` | CREPE tiny | ~6 MB | Monophonic pitch contour |
| `audio-to-midi` | Spotify Basic Pitch | ~13 MB | Polyphonic transcription |

`stem-separation` is the headline; the other two prove that adding a
task is cheap and that the runtime amortizes well.

## Implementation pipeline

Compact, ordered. Each step is small enough to land alone.

- [ ] **1. Package skeleton.** Create `packages/lib/inference/` with the
      standard `tsconfig`, `package.json`, `src/index.ts`. Empty stubs
      compile and tree-shake. Add to root `pnpm-workspace.yaml`.
- [ ] **2. ModelStore.** OPFS read/write/verify keyed by
      `(taskKey, version)`. Streaming download with progress. SHA-256
      check via `crypto.subtle.digest`. ~120 lines.
- [ ] **3. Task type.** `defineTask<I, O>(...)` factory plus the typed
      registry pattern. No tasks yet; this is the type plumbing.
- [ ] **4. Inference Worker.** `inference.worker.ts` with `load` /
      `run` / `release` messages. Dynamic-imports `onnxruntime-web`.
      Sessions cached per-task in a `Map<TaskKey, ort.InferenceSession>`.
- [ ] **5. EngineHost.** Main-thread side that owns the worker,
      multiplexes calls, fans out progress, handles `AbortSignal`. Single
      worker shared across all tasks; concurrency is serialised inside.
- [ ] **6. Public API.** `Inference.run(...)` and `Inference.acquire(...)`
      built on EngineHost. Dynamic-import `onnxruntime-web` only inside
      the worker so the main thread never pulls it.
- [ ] **7. First task: stem-separation.** `tasks/StemSeparationTask.ts`
      with htdemucs config, STFT-domain chunker, overlap-add stitcher.
      Verify against a reference render produced by the standalone
      `demucs` CLI. Publish the task ONNX file to
      `assets.opendaw.studio` once the integration test passes.
- [ ] **8. Studio wiring.** A "Separate stems" action on the audio
      track context menu. Action body is a single dynamic import:
      ```ts
      const {Inference} = await import("@opendaw/lib-inference")
      const stems = await Inference.run("stem-separation", ...)
      ```
      Plus a progress dialog driven by the `progress` callback.
- [ ] **9. Two more tasks.** `pitch-estimation` and `audio-to-midi`,
      each as a single file under `tasks/`. Confirms the registry
      pattern is friction-free for additions.
- [ ] **10. Cleanup tooling.** A small `Inference.evictUnusedModels()`
      helper that walks OPFS and removes models for tasks whose registry
      entries are gone. Optional for v1; nice-to-have once a few tasks
      have shipped and versions have rotated.

## Open questions

- **Distribution of model files.** Self-host on `assets.opendaw.studio`
  (full control, predictable URLs, license-clean copies pinned by hash)
  or pull directly from Hugging Face (lower bandwidth bill, less
  control, license-redistribution concerns per model). Recommendation:
  self-host the v1 set.
- **Concurrent task calls.** A single worker serialises by default. If
  two tasks are invoked in parallel, the second waits. Worth measuring
  whether spawning a per-task worker (each with its own ORT session)
  helps; probably not, since inference is GPU-bound on WebGPU and CPU-
  bound on WASM and either way contended.
- **Cache eviction policy.** Beyond explicit `evictUnusedModels()`, do
  we cap total OPFS usage? Browsers already enforce origin quotas; v1
  can rely on those and only add explicit eviction if reports come in.
- **Pre-warm on idle.** Pre-fetching popular models on idle (after the
  user has had openDAW open for some minutes) trades bandwidth for
  faster first-use. Off by default; opt-in via a setting if it ships
  later.
- **Result streaming.** htdemucs takes 30-90 s; users may want partial
  results as chunks complete. The worker can post intermediate
  Float32Array windows via `progress` payloads. Out of scope for v1
  but the API leaves room (`progress` payload could become a tagged
  union later).
- **WebNN migration path.** When WebNN ships across browsers, ORT-Web
  gains a `webnn` execution provider that should be a transparent
  upgrade. The `executionProviders` list will gain `"webnn"` at the
  front. No public-API change anticipated.

## Why this is not yet part of the SDK

Two reasons:

1. The API surface is brand new and will likely change in v2 once a
   handful of tasks have shipped. Promoting to SDK now would lock in
   a shape that has not been exercised.
2. Models and their licenses are still in flux. SDK consumers carrying
   ML inference need explicit guidance on weight licensing per task,
   which is a separate body of work.

The package can graduate to the SDK once both points are settled.
Until then, the studio consumes it directly from the workspace.
