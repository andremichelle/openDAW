# Code FX — Scripting DSP Device with Spectrum Analyser

## Concept

An educational device where students write DSP code in a scripting editor and see the frequency/harmonic response in a connected spectrum analyser. Inspired by Plugin Doctor's static response analysis.

## Analysis Techniques

### For Linear Systems (filters, EQs)

**Impulse Response → FFT**
- Send a Dirac impulse (single sample at 1.0, rest zeros) through the user's code
- Capture the output (impulse response)
- FFT the IR: magnitude → frequency response, phase → phase response
- One-shot, perfectly static, mathematically exact
- This works because a Dirac impulse has equal energy at all frequencies

### For Nonlinear Systems (distortion, compression, waveshaping)

Impulse method breaks down because the output depends on signal level.

**1. Logarithmic Swept Sine (Farina method, 2000)**
- Generate a log sweep from 20 Hz to Nyquist over N seconds
- Pass through the system, capture output
- Deconvolve: inverse-FFT of `Output(f) / Input(f)`
- Log sweep's special property: harmonic distortion products arrive at different times in the IR, separating cleanly
- Result: linear frequency response AND individual harmonic distortion orders (2nd, 3rd, 4th...) from a single measurement
- This is what Plugin Doctor primarily uses

**2. Single-Tone Harmonic Analysis (THD)**
- Send a pure sine at frequency f
- FFT the output
- Measure energy at f, 2f, 3f, 4f...
- Shows the harmonic series the nonlinearity generates
- Very visual for students — they can see how waveshaping creates overtones

**3. Two-Tone Intermodulation (IMD)**
- Send two sines at f1 and f2
- Look for new frequencies at f1±f2, 2f1±f2, etc. in the output
- Demonstrates how nonlinearities create frequencies that weren't in the input

**4. Level-Dependent Frequency Response**
- Run impulse or sweep at multiple input levels, overlay curves
- Shows how behaviour changes with level (e.g. compressor flattening)

## Proposed Device Architecture

- **Code editor**: student writes DSP code (init + process functions)
- **Mode 1 — Impulse**: Dirac → FFT → frequency + phase response (filters)
- **Mode 2 — Single tone**: adjustable frequency sine → FFT → harmonic spectrum (distortion)
- **Mode 3 — Swept sine**: log chirp → deconvolution → linear IR + harmonic separation (advanced)
- **Spectrum display**: magnitude in dB vs frequency (log scale)

Mode 1 and 2 cover 90% of educational value. Mode 3 (Farina) is the advanced showpiece.

## Scripting Language Design

### Requirements

The processor must be **stateful** — many DSP algorithms need persistent memory:
- Delay lines (circular buffers)
- Filter state (previous samples, coefficients)
- Accumulators, phase counters, envelopes

### Execution Model

Everything is declared on a single `class Processor`. Static fields describe the device to the host (parameters, type). Instance methods handle the runtime DSP.

#### Static Declarations

The host reads these from the class itself (before instantiation) on the main thread to configure the Box, create knobs, set up the signal chain, etc.

- `static type: "effect" | "instrument"` — determines signal routing. Effects receive audio input; instruments receive MIDI notes and generate audio. Default: `"effect"`.
- `static params: ParamDescriptor[]` — declares automatable parameters. Each entry becomes a ParameterBox in the device's Box, with a knob in the editor.

```typescript
type ParamDescriptor = {
    name: string
    min: number
    max: number
    default: number
    mapping: "linear" | "exp" | "log" | "int"
}
```

Supported mappings:
- `linear` — uniform distribution (default). Use for mix, gain, pan, etc.
- `exp` — exponential distribution. Use for frequency, time constants, etc.
- `log` — logarithmic distribution. Use for dB values.
- `int` — linear but snapped to integers. Use for semitones, choices, etc.

The mapping defines how the knob's 0→1 range maps to min→max. Parameter values passed to `paramChanged()` are always the mapped value (not the raw 0→1).

#### Instance Methods

- `constructor()` — allocate memory, initialise state. `sampleRate` is available on `globalThis`.
- `process(inputL: Float32Array, inputR: Float32Array, outputL: Float32Array, outputR: Float32Array, fromIndex: number, toIndex: number): void` — block-based stereo processing. The host reads `block.s0`/`block.s1` and passes them as `fromIndex`/`toIndex` — the user never sees the Block type.
- `paramChanged?(name: string, value: number)` — called when a parameter is updated (for recalculating coefficients)
- `noteOn?(note: number, velocity: number)` — called when a note starts (instruments only)
- `noteOff?(note: number)` — called when a note ends (instruments only)

### Parameter Integration with openDAW

Parameters must be real Box fields — not ephemeral runtime state. This means:
- Each `param` declaration creates a ParameterField in the device's Box
- The field stores the current value, min, max, default, mapping
- Automation lanes, MIDI learning, knobs all bind to this field (standard openDAW pipeline)

#### Live Code Editing — Parameter Reconciliation

When the user edits code and recompiles, the parameter declarations may have changed. The editor must diff the old and new parameter lists and reconcile:

**Matching by name** (not index, since order may change):
- **Unchanged param**: keep existing Box field, value, automation — do nothing
- **New param**: create new Box field with default value, add knob to editor
- **Removed param**: delete Box field, remove knob, delete associated automation lanes entirely
- **Modified param** (same name, different min/max/mapping/default):
  - Update field metadata (min, max, mapping)
  - Clamp existing value and automation points to new range
  - If mapping type changed (e.g. linear → exp), existing automation curves may need re-interpretation or a user warning

This reconciliation should happen inside an `editing.modify()` transaction so it can be undone as a single step.

#### Box Schema

The device Box stores the code source and a dynamic list of parameter fields:
- `code: StringField` — the source code
- `parameters: ListField<ParameterBox>` — ordered list of parameter definitions

Each `ParameterBox` contains:
- `name: StringField`
- `value: Float64Field` (the automatable value)
- `min: Float64Field`
- `max: Float64Field`
- `default: Float64Field`
- `mapping: StringField` (linear / exp / log / int)

The compiler parses `param` declarations and produces a parameter manifest. The editor diffs this manifest against the existing Box parameter list to reconcile.

### TypeScript as the Scripting Language

Use plain TypeScript — no custom language, no parser, no WASM compiler. The student writes a class implementing a known interface. This eliminates ~2500 lines of compiler infrastructure and gives students a language they already know.

### Integration with openDAW's Audio Engine

openDAW does NOT use separate AudioWorkletNodes per device. All device processors are plain TypeScript classes running inside a **single EngineProcessor** (AudioWorklet). They are instantiated by `DeviceProcessorFactory` and called during the engine's processing loop. We cannot create new AudioWorkletNodes — that would break the engine's audio graph, buffer management, and processing order.

See `plans/loading-devices-at-runtime.md` for the full runtime device loading architecture.

#### Loading User Code into the Worklet

The `AudioWorkletGlobalScope` has no `eval()`, `new Function()`, `import()`, or `fetch()`. The only way to load code is `audioContext.audioWorklet.addModule(url)` from the main thread.

**Recompile flow:**

1. **Main thread**: student edits code, triggers recompile
2. **Main thread**: wrap the user code in a module that registers a processor factory on `globalThis.openDAW.codeFxProcessors[uuid]`
3. **Main thread**: create a `Blob` URL from the wrapped source
4. **Main thread**: `audioContext.audioWorklet.addModule(blobUrl)` — loads the module into the shared worklet scope
5. **Worklet**: the existing `CodeFxDeviceProcessor` picks up the new factory from `globalThis.openDAW.codeFxProcessors[uuid]` and swaps in the new user processor instance (resetting state)

The `CodeFxDeviceProcessor` is a standard device processor (like `WaveshaperDeviceProcessor`). It delegates `processAudio(block)` to the user's `Processor` instance, extracting `block.s0`/`block.s1` as the sample range (per the block-fix refactor — see `plans/block-fix.md`). The host wraps every call with:
- **Error recovery**: try/catch around `process()` — runtime exceptions silence the processor and report the error to the editor instead of crashing the engine
- **Peak metering**: `PeakBroadcaster.process()` runs on the output after the user's code, providing level meters in the device editor
- **Version gating**: if the BoxGraph version doesn't match the loaded code, the processor outputs silence until the new module arrives

The user never deals with any of this — they just write `process()` and the host handles the rest. On recompile, the host retrieves the new `Processor` class from the registry, instantiates it via `new Processor()`, and swaps in the new instance — no new AudioWorkletNode, no disruption to the engine.

**Scoping**: Classes loaded via `addModule()` land on the shared `AudioWorkletGlobalScope`. A second `addModule()` defining the same class name would overwrite the first. To prevent collisions between multiple Code FX instances, the generated wrapper wraps the entire user code in a **named IIFE**. All user-defined classes and variables are trapped in the closure — nothing leaks to the global except the factory registration. The named function (derived from a short UUID) ensures meaningful error stack traces instead of `<anonymous>`:

```javascript
// Generated wrapper around user code
globalThis.openDAW.codeFxProcessors["<uuid>"] = (function CodeFx_a1b2c3() {
    // --- user code starts here ---
    class Biquad { /* student helper class — safely scoped */ }
    class Processor {
        process(sample, params) { /* can use Biquad from closure */ }
    }
    // --- user code ends here ---
    return Processor
})()
```

Two Code FX instances can both define `class Biquad` without collision. Each is inside its own IIFE closure.

**Synchronization**: Recompiling creates a race between two independent update channels:

1. **BoxGraph sync** — parameter reconciliation (add/remove/update ParameterBoxes) propagates through the normal Box synchronization path
2. **`addModule()`** — the new Processor class arrives separately via module loading

These are not atomic. The worklet may see new Box state (changed parameters) before the new class arrives, or the new class may land while the old Box state is still active. Both cases can invalidate the currently running processor instance — it may reference parameters that no longer exist, or receive parameters it doesn't understand.

**Solution — version gating**: Each recompile increments a version counter stored in the Box. The generated module wrapper includes this version:

```javascript
globalThis.openDAW.codeFxProcessors["<uuid>"] = {
    version: 42,
    create: (function CodeFx_a1b2c3() {
        class Processor { /* ... */ }
        return Processor
    })()
}
```

The `CodeFxDeviceProcessor` in the worklet:
- Watches the Box version field
- When it changes, **immediately silences the old processor** (outputs zeros) — the old code is potentially invalid given the new parameter set
- Polls the registry each `processAudio()` call for a matching version
- Once the new class arrives with the matching version, instantiates it and resumes processing

This ensures the processor never runs with mismatched Box state and code. The brief silence during the swap is acceptable — the student just hit "recompile".

**Error handling**: Syntax errors from `addModule()` reject the Promise on the main thread. Runtime exceptions in `process()` must be caught by the `CodeFxDeviceProcessor` wrapper (to prevent crashing the entire engine) and forwarded to the main thread via `MessagePort` for display in the editor.

Memory (delay lines, buffers) is just typed arrays — `Float32Array` for audio buffers (matches Web Audio's native format), `Float64Array` for state requiring precision (filter coefficients, phase accumulators). Students choose per buffer as needed. All `number` values in JS are 64-bit floats, so `process()` parameters and return values are inherently double precision.

### Host-Side Reflection

When the user's code is compiled, the IIFE returns the `Processor` class. On the main thread, the host reads the static fields before sending anything to the worklet:

```typescript
const ProcessorClass = iife() // returned from the IIFE
const type = ProcessorClass.type ?? "effect"
const params = ProcessorClass.params ?? []
```

The host diffs `params` against the existing Box parameter list (reconciliation by name — see below), updates the signal chain based on `type`, then sends the class to the worklet where it is instantiated via `new Processor()`.

### Example: Simple Delay

```typescript
class Processor {
    static params = [
        {name: "time", min: 0.001, max: 2.0, default: 0.5, mapping: "exp"},
        {name: "feedback", min: 0, max: 0.95, default: 0.5, mapping: "linear"}
    ]
    readonly bufferL = new Float32Array(sampleRate * 2)
    readonly bufferR = new Float32Array(sampleRate * 2)
    writeHead = 0
    delaySamples = sampleRate * 0.5
    feedback = 0.5
    paramChanged(name: string, value: number) {
        if (name === "time") this.delaySamples = value * sampleRate
        if (name === "feedback") this.feedback = value
    }
    process(inputL: Float32Array, inputR: Float32Array,
            outputL: Float32Array, outputR: Float32Array,
            fromIndex: number, toIndex: number): void {
        for (let i = fromIndex; i < toIndex; i++) {
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

```typescript
class Processor {
    static params = [
        {name: "cutoff", min: 20, max: 20000, default: 1000, mapping: "exp"},
        {name: "resonance", min: 0.1, max: 10, default: 0.707, mapping: "linear"}
    ]
    // Stereo filter state (independent L/R)
    x1L = 0; x2L = 0; y1L = 0; y2L = 0
    x1R = 0; x2R = 0; y1R = 0; y2R = 0
    b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0
    cutoff = 1000; resonance = 0.707
    paramChanged(name: string, value: number) {
        if (name === "cutoff") this.cutoff = value
        if (name === "resonance") this.resonance = value
        this.recalcCoefficients(this.cutoff, this.resonance)
    }
    recalcCoefficients(cutoff: number, resonance: number) {
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
    process(inputL: Float32Array, inputR: Float32Array,
            outputL: Float32Array, outputR: Float32Array,
            fromIndex: number, toIndex: number): void {
        for (let i = fromIndex; i < toIndex; i++) {
            // Left channel
            const outL = this.b0 * inputL[i] + this.b1 * this.x1L + this.b2 * this.x2L
                - this.a1 * this.y1L - this.a2 * this.y2L
            this.x2L = this.x1L; this.x1L = inputL[i]
            this.y2L = this.y1L; this.y1L = outL
            outputL[i] = outL
            // Right channel
            const outR = this.b0 * inputR[i] + this.b1 * this.x1R + this.b2 * this.x2R
                - this.a1 * this.y1R - this.a2 * this.y2R
            this.x2R = this.x1R; this.x1R = inputR[i]
            this.y2R = this.y1R; this.y1R = outR
            outputR[i] = outR
        }
    }
}
```

### Example: Simple Sine Synth (Instrument)

```typescript
class Processor {
    static type = "instrument" as const
    static params = [
        {name: "attack", min: 0.001, max: 2.0, default: 0.01, mapping: "exp"},
        {name: "release", min: 0.001, max: 2.0, default: 0.1, mapping: "exp"}
    ]
    phase = 0; phaseInc = 0
    envelope = 0; gate = 0
    attackCoeff = 0; releaseCoeff = 0
    paramChanged(name: string, value: number) {
        if (name === "attack") this.attackCoeff = Math.exp(-1 / (value * sampleRate))
        if (name === "release") this.releaseCoeff = Math.exp(-1 / (value * sampleRate))
    }
    noteOn(note: number, velocity: number) {
        this.phaseInc = (440 * Math.pow(2, (note - 69) / 12)) / sampleRate
        this.gate = velocity / 127
    }
    noteOff(note: number) {
        this.gate = 0
    }
    process(inputL: Float32Array, inputR: Float32Array,
            outputL: Float32Array, outputR: Float32Array,
            fromIndex: number, toIndex: number): void {
        for (let i = fromIndex; i < toIndex; i++) {
            const coeff = this.gate > 0 ? this.attackCoeff : this.releaseCoeff
            this.envelope = this.envelope * coeff + this.gate * (1 - coeff)
            this.phase += this.phaseInc
            if (this.phase >= 1) this.phase -= 1
            const sample = Math.sin(this.phase * Math.PI * 2) * this.envelope
            outputL[i] = sample
            outputR[i] = sample
        }
    }
}
```

## Pseudo-Implementation

Based on existing openDAW patterns (MIDIOutputDevice for dynamic parameters, WaveshaperDevice for audio effects).

### 1. Forge Schema

#### CodeFxDeviceBox (forge-boxes)

```typescript
// schema/devices/audio-effects/CodeFxDeviceBox.ts
export const CodeFxDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("CodeFxDeviceBox", {
    10: {type: "string", name: "code", value: ""},
    11: {type: "int32", name: "version", constraints: "any", unit: ""},
    12: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}}
})
```

#### CodeFxParameterBox (forge-boxes)

```typescript
// schema/devices/audio-effects/CodeFxParameterBox.ts
export const CodeFxParameterBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "CodeFxParameterBox",
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

### 2. Adapter

```typescript
// CodeFxDeviceBoxAdapter.ts
export class CodeFxDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.CodeFx

    readonly #terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #box: CodeFxDeviceBox
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: CodeFxDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        // Dynamic parameters — same pattern as MIDIOutputDeviceBoxAdapter
        this.#terminator.own(
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: ({box}) => {
                    const paramBox = asInstanceOf(box, CodeFxParameterBox)
                    const mapping = this.#resolveMapping(paramBox)
                    this.#parametric.createParameter(
                        paramBox.value, mapping.valueMapping, mapping.stringMapping,
                        paramBox.name.getValue())
                },
                onRemoved: ({box}) => this.#parametric
                    .removeParameter(asInstanceOf(box, CodeFxParameterBox).value.address)
            })
        )
    }

    #resolveMapping(paramBox: CodeFxParameterBox): {
        valueMapping: ValueMapping<number>,
        stringMapping: StringMapping<number>
    } {
        const min = paramBox.min.getValue()
        const max = paramBox.max.getValue()
        const mapping = paramBox.mapping.getValue()
        switch (mapping) {
            case "exp":
                return {
                    valueMapping: ValueMapping.exp(min, max),
                    stringMapping: StringMapping.numeric({fractionDigits: 2})
                }
            case "log":
                return {
                    valueMapping: ValueMapping.log(min, max),
                    stringMapping: StringMapping.numeric({fractionDigits: 1, unit: "dB"})
                }
            case "int":
                return {
                    valueMapping: ValueMapping.linearInteger(min, max),
                    stringMapping: StringMapping.numeric({fractionDigits: 0})
                }
            default:
                return {
                    valueMapping: ValueMapping.linear(min, max),
                    stringMapping: StringMapping.numeric({fractionDigits: 2})
                }
        }
    }

    get box(): CodeFxDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get indexField(): Int32Field {return this.#box.index}
    get parameters(): ParameterAdapterSet {return this.#parametric}
    // ... standard boilerplate (deviceHost, audioUnitBoxAdapter, etc.)

    terminate(): void {this.#terminator.terminate()}
}
```

### 3. Parameter Reconciliation (Main Thread)

```typescript
// CodeFxParameterReconciler.ts
type ParamDescriptor = {
    name: string
    min: number
    max: number
    default: number
    mapping: string
}

export namespace CodeFxParameterReconciler {
    export const reconcile = (
        editing: Editing,
        boxGraph: BoxGraph,
        deviceBox: CodeFxDeviceBox,
        newParams: ReadonlyArray<ParamDescriptor>
    ): void => {
        editing.modify(() => {
            // Collect existing parameter boxes by name
            const existing = new Map<string, CodeFxParameterBox>()
            for (const pointer of deviceBox.parameters.pointerHub.filter(Pointers.Parameter)) {
                const paramBox = asInstanceOf(pointer.box, CodeFxParameterBox)
                existing.set(paramBox.name.getValue(), paramBox)
            }
            const newNames = new Set(newParams.map(desc => desc.name))

            // Remove parameters that no longer exist
            for (const [name, paramBox] of existing) {
                if (!newNames.has(name)) {
                    paramBox.delete() // deletes box + all automation pointing to it
                }
            }

            // Add or update parameters
            for (const desc of newParams) {
                const existingBox = existing.get(desc.name)
                if (isDefined(existingBox)) {
                    // Update metadata if changed
                    if (existingBox.min.getValue() !== desc.min) existingBox.min.setValue(desc.min)
                    if (existingBox.max.getValue() !== desc.max) existingBox.max.setValue(desc.max)
                    if (existingBox.defaultValue.getValue() !== desc.default) existingBox.defaultValue.setValue(desc.default)
                    if (existingBox.mapping.getValue() !== desc.mapping) existingBox.mapping.setValue(desc.mapping)
                    // ISSUE: Existing value/automation may be out of new range — needs clamping
                    // ISSUE: Changing mapping type invalidates existing automation curves
                } else {
                    // Create new parameter box
                    CodeFxParameterBox.create(boxGraph, UUID.generate(), paramBox => {
                        paramBox.owner.refer(deviceBox.parameters)
                        paramBox.name.setValue(desc.name)
                        paramBox.min.setValue(desc.min)
                        paramBox.max.setValue(desc.max)
                        paramBox.defaultValue.setValue(desc.default)
                        paramBox.mapping.setValue(desc.mapping)
                        // ISSUE: Float32Field constraints are set at creation time.
                        //        How do we create a Float32Field with dynamic min/max?
                        //        The forge schema defines "unipolar" (0-1) constraints.
                        //        The value mapping in the adapter handles the real range.
                        //        So the Box stores a normalized 0-1 value, and the adapter
                        //        maps it to the user's min/max range. This is consistent
                        //        with how all other parameters work.
                    })
                }
            }

            // Bump version to signal worklet
            deviceBox.version.setValue(deviceBox.version.getValue() + 1)
        })
    }
}
```

### 4. Recompile Flow (Main Thread)

```typescript
// CodeFxCompiler.ts
export namespace CodeFxCompiler {
    export const compile = async (
        audioContext: BaseAudioContext,
        editing: Editing,
        boxGraph: BoxGraph,
        deviceBox: CodeFxDeviceBox
    ): Promise<void> => {
        const code = deviceBox.code.getValue()
        const uuid = UUID.toString(deviceBox.address.uuid)
        const version = deviceBox.version.getValue() + 1

        // 1. Wrap user code in named IIFE
        const shortId = uuid.slice(0, 8)
        const wrappedCode = `
            globalThis.openDAW.codeFxProcessors["${uuid}"] = {
                version: ${version},
                create: (function CodeFx_${shortId}() {
                    ${code}
                    return Processor
                })()
            }
        `

        // 2. Read static declarations from the class on the main thread
        //    We need to evaluate the IIFE to get the class, read its statics,
        //    then do the reconciliation before loading into the worklet.
        //    ISSUE: We can eval on the main thread to read statics,
        //    but the user code may reference `sampleRate` (a worklet global).
        //    Static fields that use `sampleRate` would fail.
        //    Solution: static params/type should not reference sampleRate.
        //    They are declarative metadata, not runtime code.
        const tempFn = new Function(`
            ${code}
            return Processor
        `)
        const ProcessorClass = tempFn()
        const params: ParamDescriptor[] = ProcessorClass.params ?? []
        const type: string = ProcessorClass.type ?? "effect"

        // 3. Reconcile parameters in BoxGraph
        CodeFxParameterReconciler.reconcile(editing, boxGraph, deviceBox, params)
        // This also bumps the version, which syncs to worklet via BoxGraph

        // 4. Load wrapped code into worklet
        const blob = new Blob([wrappedCode], {type: "application/javascript"})
        const blobUrl = URL.createObjectURL(blob)
        try {
            await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
            URL.revokeObjectURL(blobUrl)
        }
        // ISSUE: addModule rejects on syntax errors. We need to catch
        // and display the error in the editor. But we already bumped the
        // version and reconciled params. If addModule fails, the worklet
        // is silenced waiting for a version that will never arrive.
        // Solution: Do addModule BEFORE reconciliation? No — we need the
        // class to read statics first. We could split: eval on main thread
        // to read statics (can fail with clear error), then reconcile,
        // then addModule (which only fails on syntax errors in the wrapper,
        // not the user code itself since we already successfully eval'd it).
        // Actually, if eval succeeds, addModule should also succeed — same code.
        // The risk is worklet-specific globals (sampleRate) used in
        // constructor field initializers. These exist at addModule time but
        // not at eval time. But field initializers run at instantiation, not
        // at class definition time. So addModule will succeed (it just
        // defines the class). Instantiation happens later in the worklet.
    }
}
```

### 5. Device Processor (Worklet)

```typescript
// CodeFxDeviceProcessor.ts
export class CodeFxDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    readonly #adapter: CodeFxDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #parameters: Array<AutomatableParameter<number>> = []

    #source: Option<AudioBuffer> = Option.None
    #userProcessor: Option<any> = Option.None  // instance of user's Processor class
    #currentVersion: number = -1
    #silenced: boolean = false
    #error: Option<string> = Option.None

    constructor(context: EngineContext, adapter: CodeFxDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {box, parameters} = adapter

        // Watch version changes from BoxGraph sync
        this.ownAll(
            box.version.catchupAndSubscribe(owner => {
                const newVersion = owner.getValue()
                if (newVersion !== this.#currentVersion) {
                    // BoxGraph updated — silence until matching code arrives
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#tryLoadVersion(newVersion)
                }
            }),
            // Dynamic parameter binding — same pattern as MIDIOutputDeviceProcessor
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: ({box}) => {
                    const paramBox = asInstanceOf(box, CodeFxParameterBox)
                    const param = this.bindParameter(
                        parameters.parameterAt(paramBox.value.address))
                    this.#parameters.push(param)
                },
                onRemoved: ({box}) => {
                    const paramBox = asInstanceOf(box, CodeFxParameterBox)
                    Arrays.removeIf(this.#parameters, parameter =>
                        parameter.address === paramBox.value.address)
                }
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    #tryLoadVersion(version: number): void {
        const uuid = UUID.toString(this.#adapter.uuid)
        const registry = (globalThis as any).openDAW?.codeFxProcessors?.[uuid]
        if (isDefined(registry) && registry.version === version) {
            this.#swapProcessor(registry.create, version)
        }
        // Otherwise: will try again on next processAudio call
    }

    #swapProcessor(ProcessorClass: any, version: number): void {
        try {
            this.#userProcessor = Option.wrap(new ProcessorClass())
            this.#currentVersion = version
            this.#silenced = false
            this.#error = Option.None
            // Notify user processor of current parameter values
            this.readAllParameters()
        } catch (err) {
            this.#error = Option.wrap(String(err))
            this.#silenced = true
            // ISSUE: How to forward this error to the editor?
            // Could use broadcastFloats with a special address,
            // or a dedicated MessagePort channel.
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
        // If silenced (version mismatch), poll for code arrival
        if (this.#silenced) {
            const uuid = UUID.toString(this.#adapter.uuid)
            const registry = (globalThis as any).openDAW?.codeFxProcessors?.[uuid]
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

    parameterChanged(parameter: AutomatableParameter): void {
        const paramBox = asInstanceOf(parameter.adapter.field.box, CodeFxParameterBox)
        const name = paramBox.name.getValue()
        const value = parameter.getValue() // mapped value (e.g. 20-20000 for exp cutoff)
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.paramChanged)) {
                proc.paramChanged(name, value)
            }
        })
    }

    toString(): string {return `{CodeFxDeviceProcessor}`}
}
```

### 6. Factory Registration

```typescript
// In EffectFactories.ts — add:
export const CodeFx: EffectFactory = {
    defaultName: "Code FX",
    defaultIcon: IconSymbol.Code, // ISSUE: Does IconSymbol.Code exist? Need to check/add.
    description: "Scripting DSP device with spectrum analyser",
    manualPage: DeviceManualUrls.CodeFx,
    separatorBefore: false,
    type: "audio",
    create: ({boxGraph}, hostField, index): CodeFxDeviceBox =>
        CodeFxDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Code FX")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
}

// In DeviceProcessorFactory.ts — add to AudioEffectDeviceProcessorFactory:
visitCodeFxDeviceBox: (box: CodeFxDeviceBox): AudioEffectDeviceProcessor =>
    new CodeFxDeviceProcessor(context, context.boxAdapters.adapterFor(box, CodeFxDeviceBoxAdapter))

// In BoxAdapters.ts — add to #create():
visitCodeFxDeviceBox: (box: CodeFxDeviceBox) => new CodeFxDeviceBoxAdapter(this.#context, box)

// In BoxVisitor — add:
visitCodeFxDeviceBox?(box: CodeFxDeviceBox): R

// In DeviceEditorFactory.tsx — add to toAudioEffectDeviceEditor():
visitCodeFxDeviceBox: (box: CodeFxDeviceBox) => (
    <CodeFxDeviceEditor lifecycle={lifecycle}
                        service={service}
                        adapter={service.project.boxAdapters.adapterFor(box, CodeFxDeviceBoxAdapter)}
                        deviceHost={deviceHost}/>
)
```

### 7. Editor (Sketch)

```typescript
// CodeFxDeviceEditor.tsx
export const CodeFxDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, boxGraph} = project
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateControls={() => (
                          <div className={className}>
                              {/* Code editor textarea/codemirror */}
                              <CodeEditor lifecycle={lifecycle}
                                          code={adapter.box.code}
                                          onCompile={async (code) => {
                                              adapter.box.code.setValue(code)
                                              await CodeFxCompiler.compile(
                                                  service.audioContext, editing,
                                                  boxGraph, adapter.box)
                                          }}/>
                              {/* Dynamic parameter knobs — rendered from pointerHub */}
                              <DynamicParameters lifecycle={lifecycle}
                                                 editing={editing}
                                                 adapter={adapter}/>
                              {/* Spectrum analyser display */}
                              <SpectrumDisplay lifecycle={lifecycle}
                                               adapter={adapter}/>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.CodeFx.defaultIcon}/>
    )
}
```

## Unsolved Issues

Issues discovered during pseudo-implementation:

### 1. Dynamic ValueMapping Updates
When parameter metadata changes (min/max/mapping) on recompile, the `AutomatableParameterFieldAdapter` was created with the original `ValueMapping`. The adapter doesn't support changing its mapping after construction. We would need to destroy and recreate the parameter adapter, which means losing the automation pointer binding. The MIDIOutputDevice pattern (add/remove) could work: remove the old parameter and add a new one with the new mapping — but this destroys automation.

### 2. Cleanup of addModule Code
Each `addModule()` call adds code that persists in the worklet scope forever — there's no way to unload a module. The registry entry per device UUID is overwritten on each recompile (no accumulation), and can be cleaned up via `delete globalThis.openDAW.codeFxProcessors[uuid]` in the processor's `terminate()`. But the IIFE closures from previous compiles remain in memory. Acceptable for a scripting/educational device — unlikely to be recompiled thousands of times.

## Design Decisions

Resolved during pseudo-implementation:

- **Block-based stereo processing**: `process(inputL, inputR, outputL, outputR, fromIndex, toIndex)` — the host extracts `s0`/`s1` from the per-chunk `Block` (see `plans/block-fix.md`) and passes them to the user's process method. The user never sees the `Block` type — they get plain index parameters. No per-sample function call overhead, full stereo/cross-channel capability.
- **Error recovery is host-injected**: broken code silences the processor until the next successful recompile. The user never handles this.
- **Peak metering is host-injected**: `PeakBroadcaster` runs on the output after the user's `process()` call. The user never handles this.
- **Error reporting**: add a method to `EngineContext` for forwarding runtime errors from the worklet to the main thread.
- **sampleRate in static fields**: not allowed. Static fields (`params`, `type`) are declarative metadata read on the main thread. Document this limitation. `sampleRate` is only available in instance methods and field initializers (which run at instantiation time in the worklet).
- **IconSymbol**: needs a new `IconSymbol.Code` or similar.
- **Device types**: three separate devices for audio-fx, instrument, and midi-fx. Audio-fx is the first implementation; the others integrate in future releases using the same `Processor` class contract.

## Future: WASM Compilation

If TypeScript performance becomes a bottleneck (unlikely for most use cases, but possible for heavy DSP), the same interface could be compiled to WASM. Options:

- **Direct WASM bytecode emission** from a restricted TypeScript subset (~2500 lines of compiler)
- **AssemblyScript** — TypeScript-like syntax, full compiler runs in browser
- **WAT text emission** via `wabt.js` for debugging

The TypeScript prototype establishes the interface contract. WASM becomes a drop-in optimization later.
