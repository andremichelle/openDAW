# Wasm services in a worker

Status: quick plan 2026-11-14, nothing built. Decided 2026-11-14: a new worker of its own for this, the existing
shared worker stays as it is and is refactored into the new system later.

## Goal

An editor (or any other studio code) registers a wasm module once and can then ask it for results at any time,
off the main thread, through one small generic API. The first user is the openDrum display, which renders a whole
hit every time a value changes. No per device infrastructure.

Later the audio thread gets the same service through a port of its own, so a device plugin can outsource work that
must not run in the audio callback (waveforms, tables, impulse responses, analysis).

## What exists

1. One shared worker boots with the studio (`Workers` in studio-core, `workers-main.ts` in studio-core-workers).
   It has typed channels for peaks, OPFS, transients, tempo, material analysis and sample effects.
2. That worker already loads a wasm module by url and keeps one instance per url (`stretch-wasm.ts`).
3. The openDrum preview module (`crates/opendrum-wasm`) has the shape a generic call needs: own memory, no
   imports, `alloc_floats`, and exports that read a block of floats and write a block of floats.
4. The offline renderer already hands a `MessageChannel` port to the engine, so a direct port between two realms
   is established practice here.

## Measured need

At 48 kHz one render takes 3 to 5 ms for 2 s of Snare, Clap, Tom or Hat, 10 ms for 2 s of Kick with Rumble, 14 ms
for 8 s of Hat and 26 ms for 8 s of Kick with Rumble. Short hits are fine on the main thread, long ones already
cost more than one frame while a value is dragged.

## Design

Decided 2026-11-14.

1. A new worker of its own, the existing shared worker is not touched. The generic part sets no lifetime policy:
   it offers start, call and terminate, the implementation decides how long its worker lives.
   1. Bound to an editor: start with the editor, terminate with its lifecycle.
   2. Static: one worker in a static variable of the implementation, started on first use, shared by all its
      editors (no start-up when an editor reopens). A use count can terminate it with the last editor.
   Starting a worker costs the main thread next to nothing (creating it returns at once, fetch, start and wasm
   compile run off the main thread). Measured in node: 11 ms until the worker answers, 0.2 ms to compile the 70 kB
   module, 3 ms for the first 2 s render. Not measured in a browser. A display starts empty and paints when the
   first result arrives, its area is reserved.
2. The call is untyped: `taskWorker.call("method-name", bytes, {signal, maxResultBytes})` returns a promise of
   optional bytes. Buffers are transferred in both directions, never copied. A proxy class per module wraps this
   into typed methods (floats are one view onto the bytes).
3. The worker takes compiled modules only, never urls (decided 2026-11-14). The main thread fetches and compiles
   (`WebAssembly.compileStreaming`, the compile itself runs off the main thread in the browser) and hands the
   `WebAssembly.Module` to the worker, which instantiates it as often as it needs (each instance has its own
   memory). One compile per module, kept by the implementation, so reopening an editor or restarting the worker
   compiles nothing. The same module can later go to the audio worklet.
4. Module convention, so no worker script per implementation is needed.
   1. Own memory, empty imports, `alloc(length)` returns a pointer.
   2. Every callable export has one shape: `(inputPointer, inputLength, outputPointer, outputCapacity)` returning
      the written length. All parameters travel inside the bytes.
   3. The caller passes the largest result it expects (`maxResultBytes`), it knows what it asked for.
5. Abort. A worker cannot read its message port inside a running loop, messages wait until the code returns to the
   event loop, in JavaScript and inside wasm alike. So a running job is ended in one of three ways, chosen per
   call by the implementation.
   1. Discard (the default): let it finish and drop the result. Right for short jobs like the openDrum hits.
   2. Restart: terminate the worker and start a fresh one. Always works, also for one uninterruptible loop, and
      needs nothing from the module. The compiled module is kept and handed to the new worker, so only the worker
      start repeats.
   3. Shared flag (opt in): the main thread sets a flag in shared memory (the studio is cross-origin isolated),
      a module that works in slices lets the worker check it between slices.
6. The promise takes an optional `AbortSignal`.
   1. It rejects as aborted the moment the signal fires.
   2. A job still queued is removed.
   3. A running job is ended as in 5.
   4. Latest wins needs no mechanism of its own: the caller aborts its previous request when its values change,
      a consumer's lifecycle aborts when it is gone. Aborting is per request, so a shared worker never lets one
      editor cancel another's result.
7. Errors: a failed instantiation or a trapped call rejects the promise with the module name and method name. The worker
   is restarted, the next call works again.

## Package and urls

Decided 2026-11-14.

1. One package, `packages/lib/wasm-worker` (`@opendaw/lib-wasm-worker`), with two parts: the controller for the
   main thread (`dist/index.js`, built by tsc) and the generic worker (`dist/worker.js`, bundled by esbuild into
   one self-contained file, exported as `"./worker.js"`). Nobody writes worker code, so one package keeps both
   sides on one message format. The audio side can later become a third export of the same package.
2. The package never resolves a path itself. `new URL(..., import.meta.url)` inside a library breaks in the
   consumers' bundlers (Next.js, webpack, Vite's `/@fs/` paths), which is why `asset-urls.ts` was removed again on
   2025-09-15 (b0e4a26a6) and every worker and worklet url has been passed in since.
   1. The worker url is passed to the controller. The studio imports it as
      `@opendaw/lib-wasm-worker/worker.js?worker&url`, SDK users bring it the way they already bring
      `workers-main.js` and `processors.js`.
   2. Wasm files the same: the package receives a compiled `WebAssembly.Module` and never sees a wasm url. The
      implementation that compiles it takes its url (or a base url like core-wasm's `wasmUrl`) from the host, the
      studio derives it from `BASE_URL` as it does for `stretch_wasm.wasm` and `opendrum_wasm.wasm`.
3. The studio UI (the openDrum display first) is built by Vite, so it simply imports the worker url with
   `?worker&url` and passes it. Passing urls only matters for SDK consumers once the audio engine uses the package,
   and then nothing in the package changes (decided 2026-11-14).
4. Side finding, not part of this work: lib-inference still creates its worker with
   `new URL("./workers/inference.worker.js", import.meta.url)` by default (a `workerFactory` can replace it).

## First user

The openDrum display.

1. `OpenDrumSynth` becomes the typed proxy over `call`. The preview module's exports move to the one shape of
   the convention (their loose numbers go into the bytes).
2. The display paints the last result and repaints when the next arrives. Playing a hit waits for the result that
   belongs to the current values.
3. The per trigger variation can then be shown too: the hit counter becomes one of the values in the bytes.
4. The openDrum editors share one static worker, aborts are discard.

## Audio side (later)

1. The main thread creates a `MessageChannel`, gives one port to the new worker and transfers the other to the
   audio worklet once. From then on worklet and worker talk directly, the main thread is not in the path.
2. The same untyped call runs over that port.
3. What is new and needs its own design before anything is built:
   1. A device plugin cannot wait inside the audio callback. It asks, keeps running in a defined "not ready"
      state, and takes the result at a block boundary.
   2. Asking and receiving are new host imports in the device ABI. Every plugin and SDK user depends on that, so
      it gets decided with the first device that needs it.
   3. Results land in the engine's memory without allocating in the audio callback.

## Phases

1. The package `@opendaw/lib-wasm-worker`: the generic worker and its controller, with tests (instantiate a
   compiled module, call, abort while queued, abort while running in each of the three ways, terminate, a trapping
   module), the worker bundle exported as `"./worker.js"`, the studio passing its url.
2. The openDrum preview moves onto it.
3. Audio side: design note with the first device that needs it, then build.
4. Later: refactor the existing shared worker (peaks, OPFS, transients, tempo, material, sample effects) into the
   new system.

## Open questions

1. ~~One shared worker for everything, or a second worker?~~ Decided: a new worker, the old one moves over later.
2. ~~Floats or bytes as the generic call?~~ Decided: bytes, a typed proxy on top.
3. ~~Should `open` accept a module that is already compiled, or urls only?~~ Decided: compiled modules only.
4. ~~One instance of the new worker for all services, or one per module?~~ Decided: the implementation chooses
   (bound to an editor or static). The openDrum editors use the static variant, they share one module.
5. Several workers in parallel over one compiled module (a pool): each worker instantiates the module itself, so
   calls run on separate cores. Open: the pool size (a fixed number or derived from the machine) and its first
   user. Phase 1 starts with one worker.
