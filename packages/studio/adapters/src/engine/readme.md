# EnginePreferences (Cross-Thread)

## Overview

Cross-thread preferences for the AudioEngine. Main thread holds state and broadcasts updates; audio thread clients receive updates.

## Architecture

- **Main thread:** Authority - holds state, UI modifies, broadcasts changes
- **Audio threads:** Clients - receive updates, read-only access
- **Initial state:** Sent via `processorOptions` when engine starts
- **Updates:** Broadcast full object on any change (small payload)
- **Batching:** Changes within a microtask are batched before broadcast

## Shared Utilities (lib-std)

Types in `lang.ts`:
- `PathTuple<T>` - tuple type for nested property paths
- `ValueAtPath<T, P>` - value type at a given path

Class in `observables.ts`:
- `PropertyObserver<T>` - proxy-based change detection with `catchupAndSubscribe`

## Schema

```typescript
const EnginePreferencesSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(0).max(1)
    }).default({enabled: true, beatSubDivision: 4, gain: 0.5})
})
```

## File Structure

```
packages/studio/adapters/src/engine/
├── readme.md
├── EnginePreferencesSchema.ts      # Zod schema + types
├── EnginePreferencesProtocol.ts    # Protocol interface
├── EnginePreferencesMain.ts        # Main thread: PropertyObserver + broadcast
├── EnginePreferencesClient.ts      # Audio thread: receive updates
└── EnginePreferences.test.ts       # Tests using BroadcastChannel
```

## Protocol

```typescript
interface EnginePreferencesProtocol {
    updatePreferences(preferences: EnginePreferences): void
}
```

## Usage

**Main thread:**
```typescript
const prefs = new EnginePreferencesMain()
prefs.values.metronome.enabled = false  // triggers broadcast
prefs.catchupAndSubscribe(value => console.log(value), "metronome", "gain")
prefs.connect(messenger)  // connect to audio thread
```

**Audio thread:**
```typescript
const prefs = new EnginePreferencesClient()
prefs.connect(messenger)  // receive updates
prefs.catchupAndSubscribe(value => console.log(value), "metronome", "enabled")
```

## Testing

Uses `BroadcastChannel` to emulate thread boundaries.
