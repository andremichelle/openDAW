// The AudioWorkletGlobalScope defines neither `self` nor `location`, but bundled worker glue expects both:
// vite's IIFE worker build rewrites `import.meta.url` to `self.location.href` (e.g. inside the inlined
// @opendaw/nam-wasm Emscripten glue), evaluated at module scope — one ReferenceError there kills the whole
// worklet module before `registerProcessor` runs. The href is never fetched (the nam binary arrives over
// RPC and `locateFile` is overridden), it only needs to exist. MUST stay the FIRST import of every worklet
// entry so it evaluates before any inlined glue.
const scope = globalThis as unknown as Record<string, unknown>
scope.self ??= globalThis
scope.location ??= {href: "/"}

export {}
