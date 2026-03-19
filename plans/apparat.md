# Apparat — User-Scripted Instrument

## Concept

The instrument counterpart to Werkstatt (audio DSP) and Spielwerk (MIDI effect). Users write JavaScript classes that generate audio in response to note events. Reuses the same infrastructure: code editor, compile-via-`addModule()`, version gating, error recovery, `@param` declarations with custom mappings.

Adds `@sample` declarations for loading audio files into the worklet, enabling sample playback, granular synthesis, and wavetable-like instruments. The `@sample` feature is shared infrastructure — available in Werkstatt and Apparat (and potentially Spielwerk in the future).

---

## Design Decisions (from conversation)

- **Voicing**: The host does NOT manage polyphony. The user manages their own voices in the Processor class. This keeps the API simple and gives full control.
- **Note delivery**: `noteOn(pitch, velocity, cent, id)` and `noteOff(id)` are methods on the Processor, called by the host at sample-accurate positions within the block. The host splits blocks at event boundaries and calls `process()` between them (same pattern as Vaporisateur's `AudioProcessor`).
- **Output**: `process(output, block)` where `output = [Float32Array, Float32Array]`. The host clears the buffer at the start of each block. The user writes to it however they want (`=` or `+=`).
- **Safety**: Same as Werkstatt — NaN detection + amplitude overflow protection. Processor is silenced on dangerous output.
- **Reset**: On transport stop/discontinuity, the host sends `noteOff` for all active notes, then calls `reset()`. The user MUST kill all voices in `reset()` — no tails, no release phases. This must be clearly documented in the manual and AI prompt.
- **Samples**: `// @sample name` declarations. File picker (drag-and-drop + click-to-browse) on the device panel. Data available as `this.samples.name` in the processor. Returns `null` until loaded.
- **Name**: Apparat (German for "apparatus"). Continues the naming: Werkstatt, Spielwerk, Apparat.
- **Icon**: `IconSymbol.Code` — same as Werkstatt and Spielwerk.

---

## Processor API

```javascript
// @param attack 0.01 0.001 1.0 exp s
// @param release 0.3 0.01 2.0 exp s
// @sample wavetable

class Processor {
    paramChanged(name, value) { }       // optional, same as Werkstatt/Spielwerk
    noteOn(pitch, velocity, cent, id) { }  // called at exact sample position
    noteOff(id) { }                        // called at exact sample position
    process(output, block) { }             // called between note events
    reset() { }                            // called on transport stop/discontinuity — kill all voices
}
```

### Method call order within a block

The host clears the output buffer, then interleaves note events with process calls:

```
[host clears output]
process(output, {s0: 0, s1: 47, ...})     // existing voices render
noteOn(60, 0.8, 0, 42)                     // note starts at sample 47
process(output, {s0: 47, s1: 100, ...})    // new voice renders 53 samples
noteOff(42)                                 // note ends at sample 100
process(output, {s0: 100, s1: 128, ...})   // voice in release
```

If no events in a block, `process()` is called once for the full block.

### Globals

| Variable     | Type     | Description                              |
|--------------|----------|------------------------------------------|
| `sampleRate` | `number` | Audio sample rate in Hz (e.g. 48000)     |

### Block properties

| Property | Type     | Description                                           |
|----------|----------|-------------------------------------------------------|
| `s0`     | `number` | First sample index to process (inclusive)              |
| `s1`     | `number` | Last sample index to process (exclusive)               |
| `index`  | `number` | Block counter                                          |
| `bpm`    | `number` | Current project tempo                                  |
| `p0`     | `number` | Start position in ppqn                                 |
| `p1`     | `number` | End position in ppqn                                   |
| `flags`  | `number` | Bitmask: 1=transporting, 2=discontinuous, 4=playing, 8=bpmChanged |

### Sample data

When loaded, `this.samples.name` returns the `AudioData` interface from `lib-dsp`:

```javascript
{
    sampleRate: number,                       // original sample rate
    numberOfFrames: number,                   // number of frames
    numberOfChannels: number,                 // 1 (mono) or 2 (stereo)
    frames: [Float32Array, Float32Array]      // per-channel sample data
}
```

Access channels via `this.samples.name.frames[0]` (left) and `this.samples.name.frames[1]` (right).

Returns `null` before the sample is loaded.

---

## @sample Declaration

### Format

```
// @sample <name>
```

- **name** — identifier, used to access `this.samples.name`
- Creates a file picker on the device panel (drag-and-drop + click-to-browse)
- Shows filename when loaded

### Parsing

Same pattern as `@param`: regex matches `// @sample (\w+)` lines. The compiler extracts them and reconciles sample boxes in the box graph.

### Storage

Each `@sample` declaration creates an `WerkstattSampleBox` in the box graph:
- `owner`: pointer to Apparat's samples field
- `label`: string (the sample name)
- `index`: int32 (for ordering on the panel)
- `file`: pointer to `AudioFileBox` (the audio data reference)

This follows the Playfield pattern: `PlayfieldSampleBox.file` → `AudioFileBox`.

### Loading in the worklet

Each `@sample` slot references an `AudioFileBox` in the box graph (same as Playfield). The host sets `this.samples` on the user Processor instance after construction. Each declared sample name is a property on this object:
- Before data arrives: `this.samples.name = null`
- After data arrives: `this.samples.name = AudioData` (from `lib-dsp`)

The processor uses `SampleLoaderManager.getOrCreate(uuid)` to fetch the `AudioFileBox`'s audio data asynchronously via `engineToClient.fetchAudio(uuid)`. When the data resolves, the host updates the corresponding property on `this.samples`.

---

## Architecture

### Forge Schema

```typescript
// New instrument box
export const ApparatDeviceBox = DeviceFactory.createInstrument("ApparatDeviceBox", {
    10: {type: "string", name: "code", value: ""},
    11: {type: "field", name: "parameters", pointerRules: {accepts: [Pointers.Parameter], mandatory: false}},
    12: {type: "field", name: "samples", pointerRules: {accepts: [Pointers.Sample], mandatory: false}}
})

// New sample box (similar to PlayfieldSampleBox but simpler)
export const WerkstattSampleBox = {
    type: "box",
    class: {
        name: "WerkstattSampleBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Sample, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: false}
        }
    }
}
```

Reuses `WerkstattParameterBox` for parameters (same as Werkstatt/Spielwerk).

**WerkstattDeviceBox extension**: Add `samples` field at key **12** (preserving existing keys 10=code, 11=parameters). Same field added to `SpielwerkDeviceBox` and `ApparatDeviceBox`:
```typescript
12: {type: "field", name: "samples", pointerRules: {accepts: [Pointers.Sample], mandatory: false}}
```

### Adapter

`ApparatDeviceBoxAdapter` implements `InstrumentDeviceBoxAdapter`:
- `type = "instrument"`, `accepts = "midi"`, `acceptsMidiEvents = true`
- `defaultTrackType = TrackType.Notes`
- Parses `@param` from code → creates ValueMapping/StringMapping per param (reuses `ScriptParamDeclaration`)
- Parses `@sample` from code → tracks sample boxes
- Provides `ParameterAdapterSet` for knobs

### Processor

`ApparatDeviceProcessor` extends `AudioProcessor` implements `InstrumentDeviceProcessor`:
- Watches code version, loads user class from global registry (same pattern)
- Creates `NoteEventInstrument` to receive notes from the MIDI chain
- On `handleEvent(NoteLifecycleEvent.start)` → calls `userProcessor.noteOn(pitch, velocity, cent, id)`
- On `handleEvent(NoteLifecycleEvent.stop)` → calls `userProcessor.noteOff(id)`
- On `processAudio(block)` → calls `userProcessor.process(output, block)`
- Output goes through `SimpleLimiter` + NaN detection (same as Werkstatt)
- Manages `this.samples` object on the user processor — populated via `SampleLoaderManager`
- Peak metering via `PeakBroadcaster`

### Compiler

Reuses `createScriptCompiler` with config:
```typescript
{
    headerTag: "apparat",
    registryName: "apparatProcessors",
    functionName: "apparat"
}
```

Extends `parseParams` pattern with `parseSamples` for `@sample` declarations. Reconciles both param boxes and sample boxes on compile.

### Editor

Reuses `ScriptDeviceEditor` with Apparat-specific config:
- `compiler`: apparat config
- `defaultCode`: simple sine synth
- `examples`: built-in examples
- `icon`: instrument icon
- `populateMeter`: peak meter (like Werkstatt)

The device panel additionally shows:
- Sample file pickers for each `@sample` declaration (drag-and-drop + click-to-browse, showing filename)
- Parameter knobs/checkboxes (same as Werkstatt/Spielwerk)

### Registration

Add to all dispatch points:
- `Pointers.Sample` — new pointer type in studio-enums
- `BoxVisitor.visitApparatDeviceBox` / `visitWerkstattSampleBox`
- `BoxAdapters` — create `ApparatDeviceBoxAdapter`
- `InstrumentDeviceProcessorFactory` — create `ApparatDeviceProcessor`
- `DeviceEditorFactory` — create `ApparatDeviceEditor`
- `InstrumentFactories` — register factory for creation menu
- `OfflineEngineRenderer` — load apparat code for offline rendering (alongside werkstatt/spielwerk)

---

## Examples

### Simple Sine Synth (default code)

```javascript
class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) {
        this.voices.push({
            id, velocity,
            freq: 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12),
            phase: 0, gate: true, gain: velocity
        })
    }
    noteOff(id) {
        this.voices.find(v => v.id === id)
        if (voice) voice.gate = false
    }
    reset() {
        this.voices = []
    }
    process(output, block) {
        const [outL, outR] = output
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const voice = this.voices[i]
            if (!voice.gate) {
                voice.gain *= 0.995
                if (voice.gain < 0.001) {
                    this.voices.splice(i, 1)
                    continue
                }
            }
            for (let s = block.s0; s < block.s1; s++) {
                const sample = Math.sin(voice.phase * Math.PI * 2) * voice.gain * 0.3
                outL[s] += sample
                outR[s] += sample
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}
```

### Sample Player

```javascript
// @sample sound
// @param speed 1.0 0.1 4.0 exp

class Processor {
    speed = 1.0
    voices = []
    paramChanged(name, value) {
        if (name === "speed") this.speed = value
    }
    noteOn(pitch, velocity, cent, id) {
        const sound = this.samples.sound
        if (sound === null) return
        this.voices.push({id, velocity, position: 0, data: sound})
    }
    noteOff(id) {
        this.voices = this.voices.filter(v => v.id !== id)
    }
    reset() {
        this.voices = []
    }
    process(output, block) {
        const [outL, outR] = output
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const voice = this.voices[i]
            const srcL = voice.data.frames[0]
            const srcR = voice.data.frames[voice.data.numberOfChannels > 1 ? 1 : 0]
            for (let s = block.s0; s < block.s1; s++) {
                const pos = Math.floor(voice.position)
                if (pos >= voice.data.numberOfFrames) {
                    this.voices.splice(i, 1)
                    break
                }
                outL[s] += srcL[pos] * voice.velocity
                outR[s] += srcR[pos] * voice.velocity
                voice.position += this.speed
            }
        }
    }
}
```

---

## Shared Infrastructure Reuse

| Component | Reuse from |
|---|---|
| Code editor panel | `ScriptDeviceEditor` (shared Werkstatt/Spielwerk) |
| Compiler | `createScriptCompiler` with apparat config |
| Parameter parsing | `ScriptParamDeclaration` (parseParams, resolveValueMapping, resolveStringMapping) |
| Parameter boxes | `WerkstattParameterBox` (same box, same reconciliation) |
| Code validation | `validateCode` via `new Function()` |
| Worklet registration | `registerWorklet` via `audioContext.audioWorklet.addModule()` |
| Error reporting | `engineToClient.deviceMessage(uuid, message)` |
| Sample loading | `SampleLoaderManager` / `engineToClient.fetchAudio(uuid)` pattern from Playfield |
| Sample boxes | `WerkstattSampleBox` (shared across Werkstatt/Apparat, like `WerkstattParameterBox`) |
| Sample parsing | `parseSamples` in `ScriptParamDeclaration` (shared) |
| Sample picker UI | `SampleSelector` + `SampleSelectStrategy.forPointerField` from `@/ui/devices/SampleSelector` (same as Nano) |

### New components needed

| Component | Description |
|---|---|
| `ApparatDeviceBox` | Forge schema (instrument with code, parameters, samples) |
| `WerkstattSampleBox` | Forge schema (sample slot with label, index, file pointer) |
| `ApparatDeviceBoxAdapter` | Adapter (params + samples from code) |
| `ApparatDeviceProcessor` | Worklet processor (note events → user code → audio) |
| `ApparatDeviceEditor` | Thin wrapper around `ScriptDeviceEditor` + sample pickers |
| `Pointers.Sample` | New pointer type |
| `parseSamples` | Regex parser for `@sample` declarations (in `ScriptParamDeclaration` — shared, so Werkstatt can use it too) |

---

## Pitfalls from Vaporisateur Analysis

1. **Sample-accurate event timing**: The `AudioProcessor` base class already handles block splitting at event boundaries. Apparat's processor should extend `AudioProcessor` to get this for free.

2. **NaN/overflow protection**: Must apply `SimpleLimiter` and NaN detection on the output, same as Werkstatt. User code generating audio is high-risk for runaway values.

3. **Note ID, not pitch**: `noteOff` must use `id` not `pitch` — multiple notes on the same pitch can be active simultaneously. The API makes this explicit by design.

4. **Voice cleanup**: If the user doesn't remove voices in `noteOff`, they accumulate forever. The error reporting (NaN detection, amplitude overflow) will catch runaway situations. On transport stop, the host calls `noteOff` for all active notes then `reset()` — the user MUST clear all voices in `reset()`.

5. **Sample not loaded yet**: `this.samples.name` returns `null` before loaded. User must guard access. The host should NOT call `noteOn` if samples are still loading — or should it? (The user handles null checks.)

6. **Memory in process()**: Like Werkstatt, the manual/AI prompt must emphasize: NEVER allocate in process(). No `new`, no array literals, no closures in the audio hot path.

7. **sampleRate in constructor**: Available on `globalThis` in the worklet. Instance field initializers and the constructor can use it freely.

9. **Sample rate mismatch**: The project's `sampleRate` and the sample's `AudioData.sampleRate` can differ (e.g., 48000 Hz project, 44100 Hz sample). When playing back samples, the user must calculate the playback rate as `sample.sampleRate / sampleRate` and advance the read position by this ratio per output sample. The manual and AI prompt must teach this — otherwise samples play at the wrong speed/pitch.

8. **Offline rendering**: Must register apparat code in `OfflineEngineRenderer` (same pattern as werkstatt/spielwerk).
