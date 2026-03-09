# Werkstatt — User-Scripted DSP Processor

## Concept

A device where users write DSP code in a scripting editor. The device hosts user-authored TypeScript classes inside the existing audio engine, with live recompilation and error recovery.

This is the foundation for higher-level scripted devices (e.g. Formular).

Every implementation detail (Box schema, adapter, processor, compiler, editor) should be designed so that extending to instruments (noteOn/noteOff, no audio input) and MIDI effects is a straightforward addition without restructuring existing code.

---

## Iteration 1 — Code Editor + Audio Processing (no parameters)

The minimal viable device: a code editor, a compile button, and audio pass-through. The user writes a `class Processor` with a `process()` method. No parameters, no knobs, no automation — just code in, audio out.

### Goal

Prove the full pipeline end-to-end: forge schema → generated Box → adapter → factory registration → worklet code loading → audio processing → error recovery → peak metering.

### Class Contract

```typescript
class Processor {
    process(inputL: Float32Array, inputR: Float32Array,
            outputL: Float32Array, outputR: Float32Array,
            block: {index, p0, p1, s0, s1, bpm, flags}): void {
        // user DSP code
    }
}
```

- `constructor()` — allocate memory, initialise state. `sampleRate` is available on `globalThis`.
- `process()` — block-based stereo processing. The `block` object provides:
  - `s0`/`s1` — sample range (loop indices into the Float32Arrays)
  - `p0`/`p1` — position in ppqn (pulse per quarter note)
  - `bpm` — current tempo
  - `flags` — bitmask: `1` = transporting, `2` = discontinuous, `4` = playing, `8` = bpmChanged
  - `index` — block index

### Example: Hard Clipper

```typescript
class Processor {
    process(inputL, inputR, outputL, outputR, block) {
        for (let i = block.s0; i < block.s1; i++) {
            outputL[i] = Math.max(-0.5, Math.min(0.5, inputL[i]))
            outputR[i] = Math.max(-0.5, Math.min(0.5, inputR[i]))
        }
    }
}
```

### Example: Simple Ring Modulator

```typescript
class Processor {
    phase = 0
    process(inputL, inputR, outputL, outputR, block) {
        const inc = 440 / sampleRate
        for (let i = block.s0; i < block.s1; i++) {
            const mod = Math.sin(this.phase * Math.PI * 2)
            this.phase += inc
            if (this.phase >= 1) this.phase -= 1
            outputL[i] = inputL[i] * mod
            outputR[i] = inputR[i] * mod
        }
    }
}
```

### Forge Schema

#### WerkstattBox

```typescript
export const WerkstattBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("WerkstattBox", {
    10: {type: "string", name: "code", value: ""},
    11: {type: "int32", name: "version", constraints: "any", unit: ""}
})
```

No `parameters` hook field yet — added in iteration 2.

### Adapter

```typescript
export class WerkstattBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Werkstatt

    readonly #context: BoxAdaptersContext
    readonly #box: WerkstattBox

    constructor(context: BoxAdaptersContext, box: WerkstattBox) {
        this.#context = context
        this.#box = box
    }

    get box(): WerkstattBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get indexField(): Int32Field {return this.#box.index}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    // ... standard boilerplate (deviceHost, audioUnitBoxAdapter, etc.)

    terminate(): void {}
}
```

### Recompile Flow (Main Thread)

```typescript
export namespace WerkstattCompiler {
    export const compile = async (
        audioContext: BaseAudioContext,
        deviceBox: WerkstattBox
    ): Promise<void> => {
        const code = deviceBox.code.getValue()
        const uuid = UUID.toString(deviceBox.address.uuid)
        const version = deviceBox.version.getValue() + 1
        const wrappedCode = `
            globalThis.openDAW.werkstattProcessors["${uuid}"] = {
                version: ${version},
                create: (function werkstatt() {
                    ${code}
                    return Processor
                })()
            }
        `
        deviceBox.version.setValue(version)
        const blob = new Blob([wrappedCode], {type: "application/javascript"})
        const blobUrl = URL.createObjectURL(blob)
        try {
            await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
            URL.revokeObjectURL(blobUrl)
        }
    }
}
```

### Device Processor (Worklet)

```typescript
export class WerkstattProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    readonly #adapter: WerkstattBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    #source: Option<AudioBuffer> = Option.None
    #userProcessor: Option<any> = Option.None
    #currentVersion: number = -1
    #silenced: boolean = false
    #error: Option<string> = Option.None

    constructor(context: EngineContext, adapter: WerkstattBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.ownAll(
            adapter.box.version.catchupAndSubscribe(owner => {
                const newVersion = owner.getValue()
                if (newVersion !== this.#currentVersion) {
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#tryLoadVersion(newVersion)
                }
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
    }

    #tryLoadVersion(version: number): void {
        const uuid = UUID.toString(this.#adapter.uuid)
        const registry = (globalThis as any).openDAW?.werkstattProcessors?.[uuid]
        if (isDefined(registry) && registry.version === version) {
            this.#swapProcessor(registry.create, version)
        }
    }

    #swapProcessor(ProcessorClass: any, version: number): void {
        try {
            this.#userProcessor = Option.wrap(new ProcessorClass())
            this.#currentVersion = version
            this.#silenced = false
            this.#error = Option.None
        } catch (err) {
            this.#error = Option.wrap(String(err))
            this.#silenced = true
        }
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    processAudio(block: Block): void {
        if (this.#silenced) {
            const uuid = UUID.toString(this.#adapter.uuid)
            const registry = (globalThis as any).openDAW?.werkstattProcessors?.[uuid]
            const expectedVersion = this.#adapter.box.version.getValue()
            if (isDefined(registry) && registry.version === expectedVersion) {
                this.#swapProcessor(registry.create, expectedVersion)
            }
            if (this.#silenced) {return}
        }
        if (this.#source.isEmpty() || this.#userProcessor.isEmpty()) {return}
        const {s0, s1} = block
        const source = this.#source.unwrap()
        const proc = this.#userProcessor.unwrap()
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)
        try {
            proc.process(srcL, srcR, outL, outR, s0, s1)
        } catch (err) {
            this.#silenced = true
            this.#error = Option.wrap(String(err))
        }
        this.#peaks.process(outL, outR, s0, s1)
    }

    toString(): string {return `{WerkstattProcessor}`}
}
```

### Factory Registration

```typescript
// In EffectFactories.ts
export const Werkstatt: EffectFactory = {
    defaultName: "Werkstatt",
    defaultIcon: IconSymbol.Code,
    description: "User-scripted DSP processor",
    manualPage: DeviceManualUrls.Werkstatt,
    separatorBefore: false,
    type: "audio",
    create: ({boxGraph}, hostField, index): WerkstattBox =>
        WerkstattBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Werkstatt")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
}

// In DeviceProcessorFactory.ts
visitWerkstattBox: (box: WerkstattBox): AudioEffectDeviceProcessor =>
    new WerkstattProcessor(context, context.boxAdapters.adapterFor(box, WerkstattBoxAdapter))

// In BoxAdapters.ts
visitWerkstattBox: (box: WerkstattBox) => new WerkstattBoxAdapter(this.#context, box)

// In BoxVisitor
visitWerkstattBox?(box: WerkstattBox): R

// In DeviceEditorFactory.tsx
visitWerkstattBox: (box: WerkstattBox) => (
    <WerkstattEditor lifecycle={lifecycle}
                        service={service}
                        adapter={service.project.boxAdapters.adapterFor(box, WerkstattBoxAdapter)}
                        deviceHost={deviceHost}/>
)
```

### Editor (Sketch)

```typescript
export const WerkstattEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateControls={() => (
                          <CodeEditor lifecycle={lifecycle}
                                      code={adapter.box.code}
                                      onCompile={async (code) => {
                                          adapter.box.code.setValue(code)
                                          await WerkstattCompiler.compile(
                                              service.audioContext, adapter.box)
                                      }}/>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.Werkstatt.defaultIcon}/>
    )
}
```

---

## Iteration 2 — User-Managed Parameters

Adds automatable parameters via +/- buttons in the editor. The code references them by name via `paramChanged(name, value)`.

### What Changes

**Forge schema**: Add `parameters` hook field to `WerkstattBox`, add `WerkstattParameterBox`.

```typescript
// Add to WerkstattBox
12: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}}
```

```typescript
export const WerkstattParameterBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "WerkstattParameterBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Parameter, mandatory: true},
            2: {type: "string", name: "name"},
            3: {type: "float32", name: "value", constraints: "unipolar", unit: "", pointerRules: {
                accepts: [Pointers.Modulation, Pointers.Automation, Pointers.MIDIControl],
                mandatory: true
            }},
            4: {type: "float32", name: "min", constraints: "any", unit: ""},
            5: {type: "float32", name: "max", constraints: "any", unit: ""},
            6: {type: "float32", name: "defaultValue", constraints: "any", unit: ""},
            7: {type: "string", name: "mapping", value: "linear"}
        }
    }
}
```

**Adapter**: Add `ParameterAdapterSet` with `pointerHub.catchupAndSubscribe()` (MIDIOutputDevice pattern).

```typescript
// Add to constructor
this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
this.#terminator.own(
    box.parameters.pointerHub.catchupAndSubscribe({
        onAdded: ({box}) => {
            const paramBox = asInstanceOf(box, WerkstattParameterBox)
            const mapping = this.#resolveMapping(paramBox)
            this.#parametric.createParameter(
                paramBox.value, mapping.valueMapping, mapping.stringMapping,
                paramBox.name.getValue())
        },
        onRemoved: ({box}) => this.#parametric
            .removeParameter(asInstanceOf(box, WerkstattParameterBox).value.address)
    })
)
```

Supported mappings (selectable per parameter in the UI):
- `linear` — uniform distribution. Use for mix, gain, pan, etc.
- `exp` — exponential distribution. Use for frequency, time constants, etc.
- `log` — logarithmic distribution. Use for dB values.
- `int` — linear but snapped to integers. Use for semitones, choices, etc.

The mapping defines how the knob's 0→1 range maps to min→max. Parameter values passed to `paramChanged()` are always the mapped value (not the raw 0→1).

**Processor**: Add dynamic parameter binding and `paramChanged` forwarding.

```typescript
// Add to constructor
box.parameters.pointerHub.catchupAndSubscribe({
    onAdded: ({box}) => {
        const paramBox = asInstanceOf(box, WerkstattParameterBox)
        const param = this.bindParameter(
            parameters.parameterAt(paramBox.value.address))
        this.#parameters.push(param)
    },
    onRemoved: ({box}) => {
        const paramBox = asInstanceOf(box, WerkstattParameterBox)
        Arrays.removeIf(this.#parameters, parameter =>
            parameter.address === paramBox.value.address)
    }
})

// Add method
parameterChanged(parameter: AutomatableParameter): void {
    const paramBox = asInstanceOf(parameter.adapter.field.box, WerkstattParameterBox)
    const name = paramBox.name.getValue()
    const value = parameter.getValue()
    this.#userProcessor.ifSome(proc => {
        if (isDefined(proc.paramChanged)) {
            proc.paramChanged(name, value)
        }
    })
}
```

**Editor**: Add +/- buttons and parameter list.

```typescript
const addParameter = () => {
    editing.modify(() => {
        WerkstattParameterBox.create(boxGraph, UUID.generate(), paramBox => {
            paramBox.owner.refer(adapter.box.parameters)
            paramBox.name.setValue("param")
            paramBox.min.setValue(0)
            paramBox.max.setValue(1)
            paramBox.defaultValue.setValue(0)
            paramBox.mapping.setValue("linear")
        })
    })
}
const removeParameter = (paramBox: WerkstattParameterBox) => {
    editing.modify(() => paramBox.delete())
}
```

### Class Contract (Extended)

```typescript
class Processor {
    paramChanged?(name: string, value: number): void
    process(inputL, inputR, outputL, outputR, block): void
}
```

### Example: Simple Delay

Parameters configured in the UI: `time` (0.001–2.0, exp), `feedback` (0–0.95, linear)

```typescript
class Processor {
    bufferL = new Float32Array(sampleRate * 2)
    bufferR = new Float32Array(sampleRate * 2)
    writeHead = 0
    delaySamples = sampleRate * 0.5
    feedback = 0.5
    paramChanged(name, value) {
        if (name === "time") this.delaySamples = value * sampleRate
        if (name === "feedback") this.feedback = value
    }
    process(inputL, inputR, outputL, outputR, block) {
        for (let i = block.s0; i < block.s1; i++) {
            const readHead = (this.writeHead - this.delaySamples + this.bufferL.length) % this.bufferL.length
            const delayedL = this.bufferL[readHead]
            const delayedR = this.bufferR[readHead]
            this.bufferL[this.writeHead] = inputL[i] + delayedL * this.feedback
            this.bufferR[this.writeHead] = inputR[i] + delayedR * this.feedback
            this.writeHead = (this.writeHead + 1) % this.bufferL.length
            outputL[i] = inputL[i] + delayedL
            outputR[i] = inputR[i] + delayedR
        }
    }
}
```

### Example: Biquad Lowpass with Automatable Cutoff

Parameters configured in the UI: `cutoff` (20–20000, exp), `resonance` (0.1–10, linear)

```typescript
class Processor {
    x1L = 0; x2L = 0; y1L = 0; y2L = 0
    x1R = 0; x2R = 0; y1R = 0; y2R = 0
    b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0
    cutoff = 1000; resonance = 0.707
    paramChanged(name, value) {
        if (name === "cutoff") this.cutoff = value
        if (name === "resonance") this.resonance = value
        this.recalcCoefficients(this.cutoff, this.resonance)
    }
    recalcCoefficients(cutoff, resonance) {
        const w0 = 2 * Math.PI * cutoff / sampleRate
        const alpha = Math.sin(w0) / (2 * resonance)
        const cosw0 = Math.cos(w0)
        const a0 = 1 + alpha
        this.b0 = ((1 - cosw0) / 2) / a0
        this.b1 = (1 - cosw0) / a0
        this.b2 = this.b0
        this.a1 = (-2 * cosw0) / a0
        this.a2 = (1 - alpha) / a0
    }
    process(inputL, inputR, outputL, outputR, block) {
        for (let i = block.s0; i < block.s1; i++) {
            const outL = this.b0 * inputL[i] + this.b1 * this.x1L + this.b2 * this.x2L
                - this.a1 * this.y1L - this.a2 * this.y2L
            this.x2L = this.x1L; this.x1L = inputL[i]
            this.y2L = this.y1L; this.y1L = outL
            outputL[i] = outL
            const outR = this.b0 * inputR[i] + this.b1 * this.x1R + this.b2 * this.x2R
                - this.a1 * this.y1R - this.a2 * this.y2R
            this.x2R = this.x1R; this.x1R = inputR[i]
            this.y2R = this.y1R; this.y1R = outR
            outputR[i] = outR
        }
    }
}
```

---

## Shared Architecture

### TypeScript as the Scripting Language

Use plain TypeScript — no custom language, no parser, no WASM compiler. The user writes a class implementing a known interface.

### Loading User Code into the Worklet

The `AudioWorkletGlobalScope` has no `eval()`, `new Function()`, `import()`, or `fetch()`. The only way to load code is `audioContext.audioWorklet.addModule(url)` from the main thread.

**Scoping**: The generated wrapper wraps user code in a **named IIFE**. All user-defined classes and variables are trapped in the closure — nothing leaks to the global except the factory registration. The registry key is the `WerkstattBox` UUID, so each device instance has its own slot. The named IIFE (`function werkstatt()`) ensures meaningful error stack traces instead of `<anonymous>`:

```javascript
globalThis.openDAW.werkstattProcessors["<WerkstattBox.uuid>"] = {
    version: 42,
    create: (function werkstatt() {
        class Processor { /* ... */ }
        return Processor
    })()
}
```

Two Werkstatt instances can both define `class Biquad` without collision. Each is inside its own IIFE closure.

**Version gating**: Each recompile increments a version counter stored in the Box. The `WerkstattProcessor` in the worklet:
- Watches the Box version field
- When it changes, **immediately silences the old processor** (outputs zeros)
- Polls the registry each `processAudio()` call for a matching version
- Once the new class arrives with the matching version, instantiates it and resumes processing

**Error handling**: Syntax errors from `addModule()` reject the Promise on the main thread. Runtime exceptions in `process()` are caught by the host wrapper to prevent crashing the engine.

### Stateful Processors

The processor must be **stateful** — many DSP algorithms need persistent memory:
- Delay lines (circular buffers)
- Filter state (previous samples, coefficients)
- Accumulators, phase counters, envelopes

Memory is just typed arrays — `Float32Array` for audio buffers, `Float64Array` for state requiring precision. `sampleRate` is available on `globalThis` in the worklet.

## Testing

### Offline Rendering
Werkstatt must work with offline rendering (`OfflineEngineRenderer`). The user code injection via `addModule()` must also happen on the offline `AudioContext`. Verify:
- Werkstatt processes audio correctly during `OfflineEngineRenderer.step()`
- Version gating resolves before first audio block
- Error recovery (silencing) works in offline context

## Unsolved Issues

### 1. Cleanup of addModule Code
Each `addModule()` call adds code that persists in the worklet scope forever — there's no way to unload a module. The registry entry per device UUID is overwritten on each recompile, but the IIFE closures from previous compiles remain in memory. Acceptable for a scripting device.

### 2. Error Reporting
Runtime errors caught in `processAudio()` need to reach the editor UI. Options: `broadcastFloats` with a special address, or a dedicated `MessagePort` channel.

## Design Decisions

- **Parameters managed via UI, not code**: +/- buttons in the editor create/remove `WerkstattParameterBox` instances. The code references them by name via `paramChanged()`. This eliminates host-side reflection, main-thread eval, and parameter reconciliation entirely.
- **Block-based stereo processing**: `process(inputL, inputR, outputL, outputR, fromIndex, toIndex)` — the host extracts `s0`/`s1` from the per-chunk `Block`. No per-sample function call overhead, full stereo/cross-channel capability.
- **Error recovery is host-injected**: broken code silences the processor until the next successful recompile.
- **Peak metering is host-injected**: `PeakBroadcaster` runs on the output after the user's `process()` call.
- **sampleRate in constructor**: available on `globalThis` in the worklet. Instance field initializers and the constructor can use it freely.
- **Audio-fx only**: instrument and midi-fx support deferred, but the architecture accommodates them without restructuring.

## Future: WASM Compilation

If TypeScript performance becomes a bottleneck, the same interface could be compiled to WASM. Options:
- **Direct WASM bytecode emission** from a restricted TypeScript subset
- **AssemblyScript** — TypeScript-like syntax, full compiler runs in browser
- **WAT text emission** via `wabt.js` for debugging

The TypeScript prototype establishes the interface contract. WASM becomes a drop-in optimization later.
