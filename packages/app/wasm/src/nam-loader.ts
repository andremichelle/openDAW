// The worklet -> main RPC that delivers the `@opendaw/nam-wasm` binary to the NAM bridge. Mirrors
// `SampleLoader` / `SoundfontLoader` in direction (the worklet SENDS, the main thread EXECUTES), but it is a
// one-shot: the module binary is fetched LAZILY on the first NeuralAmp model load (the TS engine's
// `fetchNamWasm` recipe) and instantiated once in the worklet next to the engine.
export interface NamLoader {
    fetchWasm(): Promise<ArrayBuffer>
}
