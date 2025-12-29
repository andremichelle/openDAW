# EnginePreferences (Cross-Thread)

## Overview

Cross-thread preferences for the AudioEngine. Main thread holds state and broadcasts updates; audio thread clients receive updates.

## Architecture

- **Main thread:** Authority - holds state, UI modifies, broadcasts changes
- **Audio threads:** Clients - receive updates, read-only access
- **Initial state:** Sent via `processorOptions` when engine starts
- **Updates:** Broadcast full object on any change (small payload)
- **Batching:** Changes within a frame are batched before broadcast

## Schema

```typescript
const EnginePreferencesSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union([z.literal(2), z.literal(4), z.literal(8)]),
        gain: z.number()
    })
})
```

## File Structure

```
packages/studio/adapters/src/engine/
├── readme.md
├── EnginePreferencesSchema.ts      # Zod schema + types
├── EnginePreferencesProtocol.ts    # Protocol interface
├── EnginePreferencesMain.ts        # Main thread: state + broadcast
├── EnginePreferencesClient.ts      # Audio thread: receive updates
└── EnginePreferences.test.ts       # Tests using BroadcastChannel
```

## Protocol

```typescript
interface EnginePreferencesProtocol {
    updatePreferences(preferences: EnginePreferences): void
}
```

Single fire-and-forget call. Main thread broadcasts entire state on any change.

## Main Thread API

```typescript
EnginePreferencesMain.values          // Proxy-wrapped, triggers broadcast on change
EnginePreferencesMain.connect(messenger)  // Connect to audio thread
EnginePreferencesMain.catchupAndSubscribe(observer, ...path)  // For UI bindings
```

## Audio Thread API

```typescript
EnginePreferencesClient.values        // Current state (read-only)
EnginePreferencesClient.connect(messenger)  // Connect to main thread
EnginePreferencesClient.catchupAndSubscribe(observer, ...path)  // For engine components
```

## Testing

Uses `BroadcastChannel` to emulate thread boundaries:

```typescript
const mainChannel = new BroadcastChannel("engine-preferences")
const audioChannel = new BroadcastChannel("engine-preferences")

EnginePreferencesMain.connect(Messenger.for(mainChannel))
EnginePreferencesClient.connect(Messenger.for(audioChannel))
```

## Notes

- Storage not implemented yet (focus on communication first)
- Multiple audio threads can exist - all receive same updates
- Not connected to existing `Preferences.ts` (separate system)
