# Neural Amp Modeler (NAM) Integration Plan for openDAW

## Executive Summary

This document outlines how to integrate Neural Amp Modeler into openDAW's audio engine, enabling guitar amp simulation with support for multiple independent instances.

## Current State Analysis

### NAM Architecture
- **Core Library**: C++ DSP library using Eigen for linear algebra
- **Neural Networks**: WaveNet (dilated convolutions), LSTM, ConvNet architectures
- **Model Format**: JSON files (`.nam`) containing architecture config + weights
- **WASM Port**: Exists at [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm)

### WASM Port Limitation
The current WASM implementation uses a **single global model**:
```cpp
std::unique_ptr<nam::DSP> currentModel;  // Single instance!
```

This prevents running multiple independent NAM instances without modification.

### openDAW Audio Architecture
- **Processing**: AudioWorklet-based, 128-sample render quantum
- **Effect Pattern**: `AudioProcessor` → `AudioEffectDeviceProcessor` interface
- **DSP Pattern**: Separate `*Dsp` classes handle sample-level processing
- **Instance Management**: Static ID counters, UUID-based tracking
- **Buffer System**: `AudioBuffer` wrapping `Float32Array` channels
- **Worklet Build**: esbuild bundles `core-processors` → `processors.js`

## Licensing

Both libraries are **MIT licensed** - fully permissive for commercial use.

### Required Attribution

Add to `THIRD_PARTY_LICENSES` or equivalent:

```
Neural Amp Modeler Core
Copyright 2023-2025 Steven Atkinson
MIT License
https://github.com/sdatkinson/NeuralAmpModelerCore

Neural Amp Modeler WASM
Copyright 2023 Steven Atkinson
MIT License
https://github.com/tone-3000/neural-amp-modeler-wasm
```

## Model Types and Performance

NAM models come in different sizes with different CPU/quality tradeoffs:

| Model Type | CPU (i7 4.2GHz) | File Size | Quality |
|------------|-----------------|-----------|---------|
| **Standard** | ~8% | ~400KB | Full fidelity, every nuance |
| **Lite** | ~5-6% | ~200KB | Nearly indistinguishable in mix |
| **Feather** | ~4-5% | ~80KB | Great for live/mixing |
| **Nano** | ~3% | ~40KB | Some loss in transients/low-end |

With Lite/Feather models, **6-8 instances** can run comfortably with CPU headroom for other processing.

## Recommended Implementation

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  SDK PACKAGE STRUCTURE                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  @opendaw/studio-core/dist/                                    │
│  ├── processors.js         # Main bundle (existing)            │
│  └── nam.wasm              # Separate file, lazy loaded        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  RUNTIME LOADING (Lazy, on first NAM device)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  MAIN THREAD                         AUDIO WORKLET THREAD       │
│                                                                 │
│  1. User adds NAM device                                        │
│     │                                                           │
│  2. fetch(namWasmUrl)                                           │
│     │ (URL derived from processors.js location)                │
│     │                                                           │
│  3. WebAssembly.compile(bytes)                                  │
│     │                                                           │
│  4. port.postMessage(                                           │
│       { type: 'nam-wasm', module }                              │
│     )                                                           │
│     │                                                           │
│     └─── module is transferable ───→ 5. WebAssembly.instantiate │
│                                             │                   │
│                                             ↓                   │
│                                      NamWasmModule ready        │
│                                             │                   │
│  6. Load .nam model JSON ──────────→ nam_loadModel(id, json)   │
│                                             │                   │
│  7. Audio processing ←───────────── nam_process(id, in, out)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 1: Create @andremichelle/nam-wasm Package

Create a separate repository/package that:
- Forks `tone-3000/neural-amp-modeler-wasm`
- Adds multi-instance support
- Includes TypeScript API wrapper
- Publishes both WASM binary and TypeScript SDK via npm

```
andremichelle/nam-wasm/              # Separate repository
├── NAM/                             # NeuralAmpModelerCore (submodule)
├── Dependencies/                    # Eigen (submodule)
├── wasm/
│   ├── CMakeLists.txt
│   ├── build.bash
│   └── nam-multi-instance.cpp       # Modified for multi-instance
├── src/
│   ├── index.ts                     # Package exports
│   └── NamWasmModule.ts             # TypeScript API wrapper
├── dist/                            # Published to npm
│   ├── nam.wasm                     # WASM binary
│   ├── index.js                     # Compiled TypeScript
│   ├── index.d.ts                   # Type definitions
│   ├── NamWasmModule.js
│   └── NamWasmModule.d.ts
├── package.json
├── tsconfig.json
├── LICENSE                          # MIT
└── README.md
```

```json
// package.json
{
  "name": "@andremichelle/nam-wasm",
  "version": "1.0.0",
  "license": "MIT",
  "description": "Neural Amp Modeler WASM with multi-instance support",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./nam.wasm": "./dist/nam.wasm"
  },
  "scripts": {
    "build:wasm": "./wasm/build.bash",
    "build:ts": "tsc",
    "build": "npm run build:wasm && npm run build:ts",
    "prepublishOnly": "npm run build"
  }
}
```

**Modified C++ for multi-instance API**:

```cpp
#include <map>
#include <memory>
#include "NAM/get_dsp.h"

namespace {
    std::map<int, std::unique_ptr<nam::DSP>> instances;
    int nextInstanceId = 0;
    float sampleRate = 48000.0f;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int nam_createInstance() {
    int id = nextInstanceId++;
    instances[id] = nullptr;
    return id;
}

EMSCRIPTEN_KEEPALIVE
void nam_destroyInstance(int id) {
    instances.erase(id);
}

EMSCRIPTEN_KEEPALIVE
bool nam_loadModel(int id, const char* jsonStr) {
    try {
        auto dsp = nam::get_dsp(jsonStr);
        if (dsp) {
            dsp->Reset(sampleRate);
            dsp->prewarm();
            instances[id] = std::move(dsp);
            return true;
        }
    } catch (...) {}
    return false;
}

EMSCRIPTEN_KEEPALIVE
void nam_process(int id, float* input, float* output, int numFrames) {
    auto it = instances.find(id);
    if (it != instances.end() && it->second) {
        it->second->process(input, output, numFrames);
    } else {
        for (int i = 0; i < numFrames; i++) {
            output[i] = input[i];
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void nam_setSampleRate(float rate) {
    sampleRate = rate;
    for (auto& [id, dsp] : instances) {
        if (dsp) dsp->Reset(rate);
    }
}

}
```

3. **Build with Emscripten**:
```bash
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make
# Output: dist/nam.wasm
```

4. **TypeScript API Wrapper** (in the same package):

```typescript
// src/index.ts
export { NamWasmModule } from "./NamWasmModule"
export type { NamWasmExports } from "./NamWasmModule"
```

```typescript
// src/NamWasmModule.ts

export interface NamWasmExports {
    nam_createInstance(): number
    nam_destroyInstance(id: number): void
    nam_loadModel(id: number, jsonPtr: number): boolean
    nam_process(id: number, inputPtr: number, outputPtr: number, numFrames: number): void
    nam_setSampleRate(rate: number): void
    memory: WebAssembly.Memory
    malloc(size: number): number
    free(ptr: number): void
}

export class NamWasmModule {
    readonly #instance: WebAssembly.Instance
    readonly #exports: NamWasmExports

    private constructor(instance: WebAssembly.Instance) {
        this.#instance = instance
        this.#exports = instance.exports as unknown as NamWasmExports
    }

    static async fromModule(module: WebAssembly.Module): Promise<NamWasmModule> {
        const instance = await WebAssembly.instantiate(module, {
            env: {
                // Emscripten imports if needed
            }
        })
        return new NamWasmModule(instance)
    }

    createInstance(): number {
        return this.#exports.nam_createInstance()
    }

    destroyInstance(id: number): void {
        this.#exports.nam_destroyInstance(id)
    }

    loadModel(id: number, modelJson: string): boolean {
        const encoder = new TextEncoder()
        const bytes = encoder.encode(modelJson + '\0')
        const ptr = this.#exports.malloc(bytes.length)
        new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes)
        const result = this.#exports.nam_loadModel(id, ptr)
        this.#exports.free(ptr)
        return result
    }

    process(id: number, input: Float32Array, output: Float32Array): void {
        const numFrames = input.length
        const inputPtr = this.#exports.malloc(numFrames * 4)
        const outputPtr = this.#exports.malloc(numFrames * 4)

        // Update heap view in case memory grew
        const heap = new Float32Array(this.#exports.memory.buffer)
        heap.set(input, inputPtr / 4)
        this.#exports.nam_process(id, inputPtr, outputPtr, numFrames)
        output.set(heap.subarray(outputPtr / 4, outputPtr / 4 + numFrames))

        this.#exports.free(inputPtr)
        this.#exports.free(outputPtr)
    }

    setSampleRate(rate: number): void {
        this.#exports.nam_setSampleRate(rate)
    }
}
```

### Phase 2: openDAW Integration - Main Thread

```typescript
// packages/studio/core/src/AudioWorklets.ts

export class AudioWorklets {
    // ... existing code ...

    static get namWasmUrl(): string {
        // WASM file is in same directory as processors.js
        const base = this.processorsUrl.substring(0, this.processorsUrl.lastIndexOf('/'))
        return `${base}/nam.wasm`
    }
}
```

```typescript
// packages/studio/core/src/EngineWorklet.ts

export class EngineWorklet extends AudioWorkletNode implements Engine {
    #namWasmLoaded: boolean = false

    async loadNamWasm(): Promise<void> {
        if (this.#namWasmLoaded) return

        const bytes = await fetch(AudioWorklets.namWasmUrl).then(response => response.arrayBuffer())
        const module = await WebAssembly.compile(bytes)

        this.port.postMessage({ type: 'nam-wasm', module })
        this.#namWasmLoaded = true
    }

    async ensureNamReady(): Promise<void> {
        if (!this.#namWasmLoaded) {
            await this.loadNamWasm()
        }
    }
}
```

### Phase 3: openDAW Integration - Worklet Thread

```typescript
// packages/studio/core-processors/src/EngineProcessor.ts

import { NamWasmModule } from "@andremichelle/nam-wasm"

export class EngineProcessor extends AudioWorkletProcessor implements EngineContext {
    #namModule: Option<NamWasmModule> = Option.None

    constructor(options: AudioWorkletNodeOptions) {
        super()
        // ... existing init ...

        // Handle WASM module transfer from main thread
        this.port.addEventListener('message', async (event) => {
            if (event.data.type === 'nam-wasm') {
                this.#namModule = Option.wrap(
                    await NamWasmModule.fromModule(event.data.module)
                )
                this.#namModule.unwrap().setSampleRate(sampleRate)
            }
        })
    }

    get namModule(): NamWasmModule {
        return this.#namModule.unwrap("NAM WASM not loaded")
    }

    get hasNamModule(): boolean {
        return this.#namModule.nonEmpty()
    }
}
```

### Phase 4: NAM Device Processor

```typescript
// packages/studio/core-processors/src/devices/audio-effects/NamDeviceProcessor.ts

import { AudioProcessor } from "../../AudioProcessor"
import { AudioEffectDeviceProcessor } from "../../DeviceProcessor"
import { AudioBuffer } from "@opendaw/lib-dsp"
import { Block } from "../../processing"
import { Option, int } from "@opendaw/lib-std"
import { Terminable } from "@opendaw/lib-lifecycle"
import { AutomatableParameter } from "../../AutomatableParameter"
import { EngineContext } from "../../EngineContext"
import { Processor } from "../../processing"

export class NamDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0
    readonly #id: int = NamDeviceProcessor.ID++

    readonly #adapter: NamDeviceBoxAdapter
    readonly #instanceId: number
    readonly #output: AudioBuffer
    #source: Option<AudioBuffer> = Option.None

    readonly parameterInputGain: AutomatableParameter<number>
    readonly parameterOutputGain: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    #modelLoaded: boolean = false
    #inputGain: number = 1.0
    #outputGain: number = 1.0
    #mix: number = 1.0

    // Reusable buffers to avoid allocations in process()
    readonly #monoInput: Float32Array = new Float32Array(128)
    readonly #monoOutput: Float32Array = new Float32Array(128)

    constructor(context: EngineContext, adapter: NamDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#instanceId = context.namModule.createInstance()
        this.#output = new AudioBuffer()

        this.parameterInputGain = this.own(this.bindParameter(adapter.namedParameter.inputGain))
        this.parameterOutputGain = this.own(this.bindParameter(adapter.namedParameter.outputGain))
        this.parameterMix = this.own(this.bindParameter(adapter.namedParameter.mix))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            { terminate: () => context.namModule.destroyInstance(this.#instanceId) }
        )
    }

    loadModel(modelJson: string): boolean {
        this.#modelLoaded = this.context.namModule.loadModel(this.#instanceId, modelJson)
        return this.#modelLoaded
    }

    get incoming(): Processor { return this }
    get outgoing(): Processor { return this }
    get audioOutput(): AudioBuffer { return this.#output }

    index(): number { return this.#adapter.index() }
    adapter(): NamDeviceBoxAdapter { return this.#adapter }

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return { terminate: () => { this.#source = Option.None } }
    }

    processAudio(block: Block, fromIndex: int, toIndex: int): void {
        if (this.#source.isEmpty()) {
            this.#output.clear()
            return
        }

        const sourceChannels = this.#source.unwrap().channels()
        const outputChannels = this.#output.channels()
        const numSamples = toIndex - fromIndex

        // Mix stereo to mono with input gain
        for (let i = 0; i < numSamples; i++) {
            const idx = fromIndex + i
            this.#monoInput[i] = (sourceChannels[0][idx] + sourceChannels[1][idx]) * 0.5 * this.#inputGain
        }

        if (this.#modelLoaded) {
            this.context.namModule.process(
                this.#instanceId,
                this.#monoInput.subarray(0, numSamples),
                this.#monoOutput.subarray(0, numSamples)
            )
        } else {
            this.#monoOutput.set(this.#monoInput.subarray(0, numSamples))
        }

        // Apply output gain and mix, expand to stereo
        for (let i = 0; i < numSamples; i++) {
            const idx = fromIndex + i
            const dry = (sourceChannels[0][idx] + sourceChannels[1][idx]) * 0.5
            const wet = this.#monoOutput[i] * this.#outputGain
            const mixed = dry * (1 - this.#mix) + wet * this.#mix
            outputChannels[0][idx] = mixed
            outputChannels[1][idx] = mixed
        }
    }

    parameterChanged(parameter: AutomatableParameter<number>): void {
        if (parameter === this.parameterInputGain) {
            this.#inputGain = this.parameterInputGain.getValue()
        } else if (parameter === this.parameterOutputGain) {
            this.#outputGain = this.parameterOutputGain.getValue()
        } else if (parameter === this.parameterMix) {
            this.#mix = this.parameterMix.getValue()
        }
    }

    reset(): void {
        this.#monoInput.fill(0)
        this.#monoOutput.fill(0)
    }

    toString(): string {
        return `{NamDeviceProcessor (${this.#id}) instance=${this.#instanceId}}`
    }
}
```

### Phase 5: Build Configuration

**In openDAW, add dependency:**

```json
// packages/studio/core-processors/package.json
{
    "dependencies": {
        "@opendaw/nam-wasm": "^1.0.0"
    },
    "scripts": {
        "build": "tsc --noEmit && npm run build:processors && npm run copy:wasm",
        "build:processors": "esbuild src/register.ts --bundle --format=esm --platform=browser --minify --sourcemap --outfile=../core/dist/processors.js",
        "copy:wasm": "cp node_modules/@opendaw/nam-wasm/dist/nam.wasm ../core/dist/nam.wasm"
    }
}
```

The WASM is fetched from npm, copied to dist at build time, and ships with the SDK.

## File Structure

**@andremichelle/nam-wasm (separate repository):**

```
nam-wasm/
├── NAM/                             # Submodule: NeuralAmpModelerCore
├── Dependencies/                    # Submodule: Eigen
├── wasm/
│   ├── CMakeLists.txt
│   ├── build.bash
│   └── nam-multi-instance.cpp
├── src/
│   ├── index.ts                     # Exports
│   └── NamWasmModule.ts             # TypeScript API
├── dist/                            # Published to npm
│   ├── nam.wasm
│   ├── index.js
│   ├── index.d.ts
│   ├── NamWasmModule.js
│   └── NamWasmModule.d.ts
├── package.json
├── tsconfig.json
└── LICENSE
```

**openDAW (this repository):**

```
packages/studio/
├── core/
│   ├── dist/
│   │   ├── processors.js      # Main bundle
│   │   └── nam.wasm           # Copied from node_modules at build
│   └── src/
│       ├── AudioWorklets.ts   # URL derivation for nam.wasm
│       └── EngineWorklet.ts   # Lazy WASM loading
│
├── core-processors/
│   └── src/
│       ├── register.ts
│       ├── EngineProcessor.ts          # WASM init via message, imports NamWasmModule
│       └── devices/
│           └── audio-effects/
│               └── NamDeviceProcessor.ts
│
└── boxes/
    └── src/
        └── devices/
            └── NamDeviceBox.ts

node_modules/
└── @andremichelle/nam-wasm/
    └── dist/
        ├── nam.wasm                 # Binary
        ├── index.js                 # API
        └── index.d.ts               # Types
```

## Technical Considerations

### Memory Management
- Each NAM model requires ~1-10MB depending on architecture
- Reuse Float32Array buffers in process() to avoid GC
- Instance limit configurable (recommend max 8-16)

### Performance
- Standard: ~8% CPU per instance (i7 @ 4.2GHz)
- Lite: ~5-6% CPU per instance
- Feather: ~4-5% CPU per instance
- Nano: ~3% CPU per instance

### WASM Loading
- WASM file ~1-2MB uncompressed
- Brotli compresses to ~400-600KB
- Only loaded when first NAM device is created
- `WebAssembly.Module` is transferable (zero-copy to worklet)

### Latency
- NAM adds minimal latency (~1-3ms depending on architecture)
- WaveNet has larger receptive field = slightly more latency

### Sample Rate
- Models trained at specific sample rates (usually 48kHz)
- Call `nam_setSampleRate()` when context sample rate is known

## Implementation Priority

**@andremichelle/nam-wasm (separate repo):**
1. Fork `tone-3000/neural-amp-modeler-wasm`
2. Modify C++ for multi-instance API
3. Create TypeScript API wrapper (`NamWasmModule.ts`)
4. Build WASM with Emscripten
5. Build TypeScript with tsc
6. Publish to npm

**openDAW (this repo):**
7. Add `@andremichelle/nam-wasm` dependency
8. Update build to copy WASM from node_modules to dist
9. Add URL derivation in `AudioWorklets.ts`
10. Implement lazy loading in `EngineWorklet.ts`
11. Update `EngineProcessor.ts` to handle WASM transfer
12. Implement `NamDeviceProcessor`
13. Create Box/Adapter layer
14. Build UI components

## Resources

- [openDAW](https://github.com/andremichelle/opendaw) - This project
- [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) - MIT License
- [neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) - MIT License
- [TONE3000 Model Library](https://www.tone3000.com/)
- [Emscripten Audio Worklets](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html)
- [Understanding NAM Types](https://www.tone3000.com/blog/understanding-nam-types)
