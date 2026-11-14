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
3. Module convention, so no worker script per implementation is needed.
   1. Own memory, empty imports, `alloc(length)` returns a pointer.
   2. Every callable export has one shape: `(inputPointer, inputLength, outputPointer, outputCapacity)` returning
      the written length. All parameters travel inside the bytes.
   3. The caller passes the largest result it expects (`maxResultBytes`), it knows what it asked for.
4. Abort. A worker cannot read its message port inside a running loop, messages wait until the code returns to the
   event loop, in JavaScript and inside wasm alike. So a running job is ended in one of three ways, chosen per
   call by the implementation.
   1. Discard (the default): let it finish and drop the result. Right for short jobs like the openDrum hits.
   2. Restart: terminate the worker and start a fresh one. Always works, also for one uninterruptible loop, and
      needs nothing from the module. The compiled module is kept and handed to the new worker, so only the worker
      start repeats.
   3. Shared flag (opt in): the main thread sets a flag in shared memory (the studio is cross-origin isolated),
      a module that works in slices lets the worker check it between slices.
5. The promise takes an optional `AbortSignal`.
   1. It rejects as aborted the moment the signal fires.
   2. A job still queued is removed.
   3. A running job is ended as in 4.
   4. Latest wins needs no mechanism of its own: the caller aborts its previous request when its values change,
      a consumer's lifecycle aborts when it is gone. Aborting is per request, so a shared worker never lets one
      editor cancel another's result.
6. Errors: a failed load or a trapped call rejects the promise with the module url and method name. The worker
   is restarted, the next call works again.

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

1. The new worker and its main thread class in studio-core, with tests (load, call, abort while queued, abort
   while running in each of the three ways, terminate, a trapping module).
2. The openDrum preview moves onto it.
3. Audio side: design note with the first device that needs it, then build.
4. Later: refactor the existing shared worker (peaks, OPFS, transients, tempo, material, sample effects) into the
   new system.

## Open questions

1. ~~One shared worker for everything, or a second worker?~~ Decided: a new worker, the old one moves over later.
2. ~~Floats or bytes as the generic call?~~ Decided: bytes, a typed proxy on top.
3. Should `open` accept a module that is already compiled (for modules the studio bundles), or urls only?
4. ~~One instance of the new worker for all services, or one per module?~~ Decided: the implementation chooses
   (bound to an editor or static). The openDrum editors use the static variant, they share one module.
