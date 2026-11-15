_This package is part of the openDAW SDK_

# @opendaw/lib-wasm-worker

Runs calls into a compiled wasm module off the main thread.

* The host compiles the module (`WebAssembly.compileStreaming`) and passes it with the url of the bundled worker
  (`@opendaw/lib-wasm-worker/worker.js`). The package never resolves a path itself.
* `WasmWorker.create({name, module, workerUrl})` starts one worker, `call(method, input, {maxResultBytes, signal})`
  resolves with the result bytes. Calls run one after another, an `AbortSignal` removes a queued call or ends a
  running one (`discard` lets it finish and drops the result, `restart` terminates the worker).

## Module convention

1. Own memory exported as `memory`, empty imports.
2. `alloc(length)` returns an 8 byte aligned pointer.
3. Every callable export: `(inputPointer, inputLength, outputPointer, outputCapacity) -> written`. A negative
   result is an error code.
