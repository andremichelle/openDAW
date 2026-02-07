---
title: Tech Stack
category: Developer Guide
tags:
  - manual
  - Developer Guide
  - tech-stack
desc: Documentation
---
# Tech Stack

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

## Monorepo

The repository is a multi-package workspace managed with npm workspaces, Turbo, and Lerna:

- Shared TypeScript config via @opendaw/typescript-config
- Consistent linting via @opendaw/eslint-config
- CI-friendly caching and parallel builds via Turbo

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
* studio-enums (Shared enumerations)
* studio-boxes (Predefined boxes)
* studio-forge-boxes (Box generators)
* studio-adapters (Adapters for audio/sample/media)
* studio-core (Core studio domain)
* studio-core-processors (AudioWorklet processors)
* studio-core-workers (Web Workers)
* studio-scripting (Scripting runtime)
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
| **studio-enums**           | std                                             |
| **studio-boxes**           | std, box, enums                                 |
| **studio-forge-boxes**     | std, runtime, box, dsp, enums                   |
| **studio-adapters**        | std, runtime, box, dsp, fusion, boxes, enums    |
| **studio-core**            | std, runtime, box, dom, dsp, fusion, dawproject, adapters, boxes, enums |
| **studio-core-processors** | std, runtime, box, dsp, adapters, boxes, enums  |
| **studio-core-workers**    | std, runtime, box, dsp, adapters, boxes, enums  |
| **studio-scripting**       | std, runtime, box, dsp, adapters, boxes, enums  |

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
* [ts-morph](https://ts-morph.com) (TypeScript AST for code generation)
