# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.1.0](https://github.com/andremichelle/openDAW/compare/@opendaw/app-wasm@0.0.2...@opendaw/app-wasm@0.1.0) (2026-07-15)

### Bug Fixes

- **tests:** copy file bytes instead of aliasing readFileSync .buffer ([b4d80dd](https://github.com/andremichelle/openDAW/commit/b4d80dd400487a2a75b934747ee4e9651dd3c6a6))

### Features

- **app-wasm:** add DnB 175 test loop (asset ae2360d9) ([6b17c47](https://github.com/andremichelle/openDAW/commit/6b17c4764db1ed198de470665c2430ea93df0a95))
- **app-wasm:** add two 140-bpm loops first in the Signalsmith list ([8c5e227](https://github.com/andremichelle/openDAW/commit/8c5e227e92eb5c842ffdd40456d23d679472d681))
- **app-wasm:** Signalsmith page — all sample loops + live metronome ([46747d4](https://github.com/andremichelle/openDAW/commit/46747d44c75b81ca15a5467d750603565ca4a49b))
- **app-wasm:** Signalsmith realtime page + live play-mode refresh ([9e707c3](https://github.com/andremichelle/openDAW/commit/9e707c3930dc3bd6dc542650f63815b5f940ba3c))

### Performance Improvements

- **signalsmith:** cache the primed state to kill the loop-wrap burst ([dd22b95](https://github.com/andremichelle/openDAW/commit/dd22b957c661ebb4bb5a66dcb92a4e01073acf1b))
- **signalsmith:** stagger per-voice FFT-burst phase to spread peak cost ([c5d8f76](https://github.com/andremichelle/openDAW/commit/c5d8f76340fefa965be159d2b9bad064a06e15d6))

## [0.0.2](https://github.com/andremichelle/openDAW/compare/@opendaw/app-wasm@0.0.1...@opendaw/app-wasm@0.0.2) (2026-07-14)

**Note:** Version bump only for package @opendaw/app-wasm

## 0.0.1 (2026-07-07)

**Note:** Version bump only for package @opendaw/app-wasm
