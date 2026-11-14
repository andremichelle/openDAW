# Wasm services in a worker

Status: phases 1 and 2 built 2026-11-14 (`packages/lib/wasm-worker`, 12 tests; the openDrum preview renders through
it). Decided 2026-11-14: a new worker of its own for this, the existing shared worker stays as it is.

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
   the bytes written. Buffers are transferred in both directions, never copied. A proxy class per module wraps this
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

## Dry run

Decided 2026-11-14, before building phases 1 and 2.

1. Now: phases 1 and 2. Phase 3 waits for the first device that needs it (its host imports are designed then).
   Phase 4 does not fit as written: the shared worker's jobs (peaks, OPFS, transients) are JavaScript, not wasm.
2. Rendering is optional. openDrum and every later device work fully without the worker, SDK users who never start
   it get devices whose editors show no hit. Nothing in a box, adapter or processor depends on it.
3. Module convention, completed:
   1. `alloc(length)` returns an 8 byte aligned pointer. The worker keeps one input and one output area per
      instance and allocates again only when a call needs more, so nothing leaks and no `free` is needed.
   2. After every `alloc` and every call the worker reads `memory.buffer` again (memory growth detaches views).
   3. A negative return is an error code and rejects the call, a return above the capacity rejects too
      ("result larger than maxResultBytes"). No automatic retry, a call may have side effects.
   4. A trap re-instantiates the module (cheap), the worker restarts only for the Restart abort.
4. One controller, one module, one name (the name appears in errors). The controller sends one call at a time and
   keeps the queue itself, so aborting a queued call removes it before the worker ever sees it.
5. Abort: Discard and Restart now, Shared flag later (it needs its own slice protocol and has no user yet).
6. Tests run the worker's logic in process over a `MessageChannel` with an injected worker factory (node has no
   browser `Worker`). That a real running wasm loop is cut off by Restart is checked in the browser only. The test
   module is a small `.wat` (alloc, copy, trap, error, loop) with its compiled bytes committed as a fixture, so
   tests need no `wat2wasm`.
7. The package builds with `tsc` plus esbuild for `dist/worker.js`, like core-wasm. Vite dev reads the built dist,
   a change to the worker needs a rebuild of the package.
8. openDrum: every engine export takes its values (sample rate, frames, velocity, bpm, parameters) from the input
   bytes and writes floats. One `param_counts` call replaces the per engine counts, the proxy checks it on load, so
   the "engine out of date" status stays. The display shows the first render only, no per hit variation.
9. The display gets peaks, not samples: the render reduces the hit in the wasm to a fixed number of min and max
   pairs over the display's time span plus the trimmed length, so neither the transfer nor the main thread handles
   a full rate 48 kHz hit while a value is dragged. Full samples are rendered only when the hit is played.
10. A value change aborts the previous request (latest wins). A click renders the full hit for the current values
   and plays it when it arrives.

## First user

The openDrum display.

1. `OpenDrumSynth` becomes the typed proxy over `call`. The preview module's exports move to the one shape of
   the convention (their loose numbers go into the bytes).
2. The display paints the last result and repaints when the next arrives. Playing a hit waits for the result that
   belongs to the current values.
3. ~~The per trigger variation can then be shown too.~~ Decided: the display shows the first render only.
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

1. ~~The package `@opendaw/lib-wasm-worker`: the generic worker and its controller, with tests, the worker bundle
   exported as `"./worker.js"`, the studio passing its url.~~ Built 2026-11-14: `WasmWorker` (controller, queue,
   Discard and Restart abort, terminate), `WasmRuntime` (worker side, instance areas, re-instantiation after a
   trap), `worker.js` (3.7 kB). 12 tests over a `MessageChannel` with a hand written test module.
2. ~~The openDrum preview moves onto it.~~ Built 2026-11-14: one export per engine plus `param_counts`, every
   export renders exactly what the old ones did. The display asks for 1024 min and max pairs (8 kB, about 5 ms in
   node for a bell), a click asks for the samples. One static worker for all displays, a value change aborts the
   previous request. Not checked in a browser yet.
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
