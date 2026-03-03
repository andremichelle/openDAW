# Configurable Base Frequency (Concert Pitch)

## Context

`midiToHz` in `@opendaw/lib-dsp` converts MIDI note numbers to Hz using a base frequency (default 440 Hz). Some musicians prefer alternative tunings like A=432 Hz. The base frequency is stored per-project in `RootBox` and exposed as a convenience getter on `EngineContext` so processors don't need to navigate the box hierarchy.

## Call Site Analysis

| Call site | File | Thread | Has `EngineContext`? | Impact |
|-----------|------|--------|---------------------|--------|
| `VaporisateurDeviceProcessor.computeFrequency` | `core-processors/.../VaporisateurDeviceProcessor.ts:153` | AudioWorklet | Yes — `this.context` | **Must use `this.context.baseFrequency`** |
| `SoundfontVoice.processAdd` | `core-processors/.../SoundfontVoice.ts:79` | AudioWorklet | No — plain class | **No change** — base frequency cancels out in pitch ratio |
| `ScriptRunner` / `Api.ts` | `scripting/src/ScriptRunner.ts:27`, `Api.ts:17` | Web Worker | No — only `sampleRate` in context | **Inject setting** into script context |
| `nano-wavetable.ts` example | `app/studio/.../nano-wavetable.ts:21` | Web Worker | No — example script | **No change** |
| `ParameterDecoder.readValue` | `lib/dawproject/src/utils.ts:29` | Main thread | No — static utility | **No change** — DAWproject uses standard 440 Hz per spec |
| `semitoneToHz` / `hzToSemitone` | `lib/dsp/src/utils.ts:18-19` | Various | N/A | **Add `baseFrequency` parameter** (default 440) like `midiToHz` already has |

## Overview of Changes

### 1. Add `baseFrequency` field to RootBox
`packages/studio/boxes/src/RootBox.ts`

Add a `Float32Field` at field key 50 with range 400–480 Hz, default 440, linear scaling.

### 2. Add `baseFrequency` getter to EngineContext
`packages/studio/core-processors/src/EngineContext.ts`

```typescript
get baseFrequency(): number
```

### 3. Implement getter in EngineProcessor
`packages/studio/core-processors/src/EngineProcessor.ts`

```typescript
get baseFrequency(): number {return this.#rootBoxAdapter.box.baseFrequency.getValue()}
```

### 4. Add `baseFrequency` parameter to `semitoneToHz` and `hzToSemitone`
`packages/lib/dsp/src/utils.ts`

Add default parameter matching the pattern `midiToHz` already uses. Existing callers unchanged.

### 5. VaporisateurDeviceProcessor — read from context
`packages/studio/core-processors/src/devices/instruments/VaporisateurDeviceProcessor.ts`

```typescript
computeFrequency(event: NoteEvent): number {
    return midiToHz(event.pitch + event.cent / 100.0, this.context.baseFrequency)
}
```

### 6. Scripting API — expose base frequency
- `ScriptExecutionContext` — add `baseFrequency: number` field
- `CodeEditorPage.tsx` — read from `project.rootBox.baseFrequency.getValue()`

### 7. UI for base frequency setting
TBD — expose the `RootBox.baseFrequency` field in the project settings UI.

## Key Files Modified

| File | Change |
|------|--------|
| `packages/studio/boxes/src/RootBox.ts` | Add `baseFrequency` Float32Field (key 50, default 440, range 400–480) |
| `packages/studio/core-processors/src/EngineContext.ts` | Add `get baseFrequency(): number` to interface |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Implement getter reading from `rootBoxAdapter.box.baseFrequency` |
| `packages/lib/dsp/src/utils.ts` | Add `baseFrequency` param to `semitoneToHz` / `hzToSemitone` |
| `packages/studio/core-processors/src/devices/instruments/VaporisateurDeviceProcessor.ts` | Use `this.context.baseFrequency` |
| `packages/studio/scripting/src/ScriptExecutionProtocol.ts` | Add `baseFrequency` to `ScriptExecutionContext` |
| `packages/studio/scripting/src/ScriptRunner.ts` | Inject `baseFrequency` into script globalThis (via `...context` spread) |
| `packages/app/studio/src/ui/pages/CodeEditorPage.tsx` | Pass `baseFrequency` from project root box |

## Notes

- The value is stored in the project via `RootBox` and persists with save/load.
- `this.context.baseFrequency` reads directly from the box field, so changes are reflected immediately.
- Future instrument processors should follow the same pattern: read `this.context.baseFrequency` instead of hardcoding 440.
