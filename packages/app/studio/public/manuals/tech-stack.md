---
title: Tech Stack
category: Developer Guide
tags:
  - manual
  - Developer Guide
  - tech-stack
desc: Documentation
---
# Tech-Stack

## Toolchain

* [Node.js](https://nodejs.org) (package manager)
* [Vite](https://vite.dev) (dev server & build)
* [Vitest](https://vitest.dev) (unit tests)
* [Typescript](https://www.typescriptlang.org)
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

* std (Core utilities, Option/UUID/Observable)
* dsp (DSP & Sequencing)
* dom (DOM Integration)
* jsx ([JSX](https://en.wikipedia.org/wiki/JSX_(JavaScript)) Integration)
* lib-midi (MIDI utilities)
* lib-xml (XML IO)
* lib-dawproject (DAWproject app agnostic IO)
* runtime (Runtime utilities, scheduling, network helpers)
* box (Runtime Immutable Data Graph)
* box-forge (Box SourceCode Generator)
* fusion (Composition utilities)
* studio-core (Core studio domain)
* studio-boxes / studio-forge-boxes (predefined boxes & generators)
* studio-adapters (adapters for audio/sample/media)
* studio-core-processors (AudioWorklet/processors)
* studio-core-workers (Web Workers)

### Dependency Table

| Library                    | Dependencies                 |
|----------------------------|------------------------------|
| **std**                    | none                         |
| **dsp**                    | std                          |
| **dom**                    | std                          |
| **jsx**                    | std, dom                     |
| **runtime**                | std                          |
| **box**                    | std, dom, runtime            |
| **box-forge**              | std, dom, box                |
| **fusion**                 | std, dom, box, runtime       |
| **lib-midi**               | std                          |
| **lib-xml**                | std                          |
| **lib-dawproject**         | std, lib-xml                 |
| **studio-core**            | std, runtime, box, dsp, dom  |
| **studio-boxes**           | std, box, studio-core        |
| **studio-forge-boxes**     | std, box-forge, studio-boxes |
| **studio-adapters**        | std, runtime                 |
| **studio-core-processors** | std, dsp, runtime            |
| **studio-core-workers**    | std, runtime                 |

### External

* [jszip](https://www.npmjs.com/package/jszip) (Pack & Unpack Zip-Files)
* [markdown-it](https://www.npmjs.com/package/markdown-it) + markdown-it-table (Markdown parsing/rendering)
* [d3-force](https://github.com/d3/d3-force) and [force-graph](https://github.com/vasturiano/force-graph) (
  graph/layout) < dynamic import