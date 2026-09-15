# Tech-Stack

## Toolchain

* [Node.js](https://nodejs.org) >= 23 (runtime & package manager)
* [Vite](https://vite.dev) 7.x (dev server & build)
* [Vitest](https://vitest.dev) 3.x (unit tests)
* [TypeScript](https://www.typescriptlang.org) 5.x
* [Sass](https://sass-lang.com)
* [ESLint](https://eslint.org) + [@typescript-eslint](https://typescript-eslint.io) + [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier)
* [Prettier](https://prettier.io)
* [Turbo](https://turbo.build) (incremental tasks)
* [Lerna](https://lerna.js.org) (workspace orchestration)
* [Rust](https://www.rust-lang.org) >= 1.82 with the `wasm32-unknown-unknown` target, a nightly toolchain for the
  device crates and [Binaryen](https://github.com/WebAssembly/binaryen) `wasm-opt` (audio engine)

## Monorepo

The repository is a multi-package workspace managed with npm workspaces, Turbo, and Lerna:

- Shared TypeScript config via @opendaw/typescript-config
- Consistent linting via @opendaw/eslint-config
- CI-friendly caching and parallel builds via Turbo
- Rust crates in `crates/` form a Cargo workspace that is built into `@opendaw/studio-core-wasm`

### Apps

* app-studio (the studio at opendaw.studio)
* app-manual (this manual, a small standalone app without the audio engine)
* app-lab (experiments)

## Audio Engine

The audio engine is written in Rust and compiled to WebAssembly. It runs inside an AudioWorklet for real-time
playback and inside a Web Worker for offline rendering (exports, freeze). Samples are written straight into the
engine's memory, so audio data is never copied between JavaScript and the engine.

* `engine` is the host module. It owns the linear memory and a shared function table.
* Every device (instruments, audio and MIDI effects, currently 30 crates in `crates/stock-devices/`) is compiled
  as its own position-independent side module and linked into the running engine at load time, so devices can
  be added without rebuilding the host.
* `engine-env` is the small standard library the devices are written against, `abi` the contract between host
  and devices, `boxgraph` and `studio-boxes` mirror the box graph on the Rust side, `dsp`, `math`, `transport`,
  `value` and `voicing` hold the shared DSP, timing, automation and voice management, `signalsmith` and `stretch`
  provide time stretching.
* Modules are optimised with `wasm-opt`. Scriptable devices (Werkstatt, Apparat, Spielwerk) run user scripts inside
  the engine.

The earlier TypeScript engine (studio-core-processors) is still shipped as a fallback.

## Libraries

openDAW uses minimal external dependencies, avoiding hidden behaviors from bulky UI frameworks.

Each in-house library has a clear, focused purpose.

### In-House Runtime

* lib-std (Core utilities, Option/UUID/Observable)
* lib-dsp (DSP & Sequencing)
* lib-runtime (Runtime utilities, scheduling, network helpers)
* lib-dom (DOM Integration)
* lib-jsx ([JSX](https://en.wikipedia.org/wiki/JSX_(JavaScript)) Integration)
* lib-box (Runtime Immutable Data Graph)
* lib-box-forge (Box SourceCode Generator)
* lib-fusion (Composition utilities)
* lib-midi (MIDI utilities)
* lib-xml (XML IO)
* lib-dawproject (DAWproject app agnostic IO)
* lib-inference (Neural network inference via ONNX Runtime, e.g. stem separation)
* studio-enums (Shared enumerations and colors)
* studio-boxes (Predefined boxes)
* studio-forge-boxes (Box generators)
* studio-adapters (Adapters for audio/sample/media)
* studio-core (Core studio domain)
* studio-core-processors (TypeScript AudioWorklet processors)
* studio-core-wasm (Rust/WebAssembly engine, worklet and offline worker glue)
* studio-core-workers (Web Workers)
* studio-p2p (Peer-to-peer project and sample exchange)
* studio-scripting (Scripting runtime and the generated scripting API docs)
* studio-icons, studio-markdown, studio-scrollbars (UI pieces shared by the studio and the manual)
* studio-sdk (Meta package for SDK distribution)

### Dependency Table

| Library                    | Dependencies                                    |
|----------------------------|-------------------------------------------------|
| **lib-std**                | none                                            |
| **lib-dsp**                | std                                             |
| **lib-runtime**            | std                                             |
| **lib-dom**                | std, runtime                                    |
| **lib-jsx**                | std, dom                                        |
| **lib-box**                | std, runtime                                    |
| **lib-box-forge**          | std, dom, runtime, box                          |
| **lib-fusion**             | std, dom, runtime, box                          |
| **lib-midi**               | std, dsp                                        |
| **lib-xml**                | std                                             |
| **lib-dawproject**         | dsp, runtime, xml                               |
| **lib-inference**          | std, runtime, fusion                            |
| **studio-enums**           | std                                             |
| **studio-boxes**           | std, box, enums                                 |
| **studio-forge-boxes**     | std, runtime, box, dsp, enums                   |
| **studio-adapters**        | std, runtime, box, dsp, fusion, boxes, enums    |
| **studio-core**            | std, runtime, box, dom, dsp, fusion, dawproject, adapters, boxes, enums |
| **studio-core-processors** | std, runtime, box, dsp, adapters, boxes, enums  |
| **studio-core-workers**    | std, runtime, box, dsp, adapters, boxes, enums  |
| **studio-scripting**       | std, runtime, box, dsp, adapters, boxes, enums  |
| **studio-core-wasm**       | std, runtime, box, dsp, fusion, adapters, boxes, core |
| **studio-p2p**             | std, runtime, dsp, adapters                     |
| **studio-icons**           | std, dom, jsx, enums                            |
| **studio-markdown**        | std, dom, jsx, runtime, enums, icons            |
| **studio-scrollbars**      | std, dom, jsx, runtime                          |

### External

* [jszip](https://www.npmjs.com/package/jszip) (Pack & Unpack Zip-Files)
* [markdown-it](https://www.npmjs.com/package/markdown-it) + markdown-it-table (Markdown parsing/rendering)
* [monaco-editor](https://microsoft.github.io/monaco-editor/) (Code editor for scripting)
* [mediabunny](https://www.npmjs.com/package/mediabunny) (Video export via WebCodecs)
* [d3-force](https://github.com/d3/d3-force) + [force-graph](https://github.com/vasturiano/force-graph) (Graph/layout)
* [dropbox](https://www.npmjs.com/package/dropbox) (Cloud storage integration)
* [yjs](https://yjs.dev) + y-websocket (Real-time collaboration)
* [zod](https://zod.dev) (Schema validation)
* [soundfont2](https://www.npmjs.com/package/soundfont2) (Soundfont parsing)
* [@ffmpeg/ffmpeg](https://ffmpegwasm.netlify.app) (Audio/Video processing)
* [onnxruntime-web](https://onnxruntime.ai) (Neural network inference)
* [@opendaw/nam-wasm](https://www.npmjs.com/package/@opendaw/nam-wasm) (Neural Amp Modeler for the Tone3000 device)
* [ts-morph](https://ts-morph.com) (TypeScript AST for code generation)
* [TypeDoc](https://typedoc.org) (Scripting API reference)
