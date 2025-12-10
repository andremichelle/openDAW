# Live Stream System

Real-time data broadcasting from audio worklet to main thread using shared memory.

## Overview

The live-stream system enables low-latency, lock-free communication between the audio worklet (EngineProcessor) and the main thread (UI components). It's used for visualizing audio data like spectrum analyzers, peak meters, and waveform displays.

## Architecture

```
Audio Worklet                              Main Thread
─────────────────                          ─────────────────
LiveStreamBroadcaster                      LiveStreamReceiver
       │                                          │
       │◄──── Messenger Channel ─────────────────►│
       │      "engine-live-data"                  │
       │                                          │
       ▼                                          ▼
  SharedArrayBuffer (lock)  ◄──────────►  AnimationFrame loop
  SharedArrayBuffer (data)  ◄──────────►  Subscribers
```

## Components

### LiveStreamBroadcaster (Audio Worklet Side)

Creates and manages data packages for broadcasting. Each package has:
- **Address**: Unique identifier (UUID + field keys)
- **Type**: Float, Integer, FloatArray, IntegerArray, ByteArray
- **Capacity**: Byte size needed for serialization

Key methods:
- `broadcastFloat(address, provider)` - Single float value
- `broadcastFloats(address, values, before?, after?)` - Float array with optional hooks
- `broadcastIntegers(address, values, update)` - Integer array
- `flush()` - Called every audio frame to send data

### LiveStreamReceiver (Main Thread Side)

Receives and dispatches data to subscribers. Runs in AnimationFrame loop.

Key methods:
- `connect(messenger)` - Establishes connection with broadcaster
- `subscribeFloat(address, procedure)` - Subscribe to float updates
- `subscribeFloats(address, procedure)` - Subscribe to float array updates
- `subscribeIntegers(address, procedure)` - Subscribe to integer array updates

## Shared Memory Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Subscription Flags │ Version │ START  │   Data...   │   END   │
│    (N bytes)       │ (4 bytes)│(4 bytes)│  (variable) │(4 bytes)│
└─────────────────────────────────────────────────────────────────┘
     ▲                    │
     │                    ▼
 Written by           Written by
 Receiver             Broadcaster
```

### Subscription Flags

The first N bytes (one per registered package) indicate whether each address has active subscribers:
- `0` = No subscribers
- `1` = Has subscribers

This allows the broadcaster to skip expensive computations (like FFT) when no UI component is listening.

## Lock Protocol

Uses a single-byte `SharedArrayBuffer` for synchronization:

```
┌─────────────────────────────────────────────────────────────────┐
│  State    │  Broadcaster Action         │  Receiver Action      │
├───────────┼─────────────────────────────┼───────────────────────┤
│  WRITE(0) │  Write data, set to READ    │  Wait                 │
│  READ(1)  │  Wait                       │  Read data, write     │
│           │                             │  subscription flags,  │
│           │                             │  set to WRITE         │
└─────────────────────────────────────────────────────────────────┘
```

### Flow Per Frame

1. **Broadcaster** (`flush()`):
   - Check if lock = `WRITE` (receiver ready)
   - Read subscription flags from SAB
   - For each package, call `before(hasSubscribers)` hook
   - Serialize data (packages can skip computation if no subscribers)
   - Write to SAB: `[version][START][data...][END]`
   - Set lock to `READ`

2. **Receiver** (`#dispatch()` in AnimationFrame):
   - Check if lock = `READ` (data ready)
   - Parse and dispatch data to subscribers
   - Write subscription flags (one byte per package)
   - Set lock to `WRITE`

## Structure Protocol

When packages are added/removed, the broadcaster sends a structure update:

```
┌──────────────────────────────────────────────────────────┐
│  ID     │ Version │ Count │ Package 1 │ Package 2 │ ... │
│(4 bytes)│(4 bytes)│(4 bytes)│          │           │     │
└──────────────────────────────────────────────────────────┘

Each Package:
┌─────────────────────────────────────┐
│  Address (variable)  │  Type (1 byte) │
└─────────────────────────────────────┘
```

The receiver uses this to:
1. Build dispatch procedures for each package
2. Know the order of packages for subscription flag mapping

## Data Protocol

```
┌─────────────────────────────────────────────────────────────────┐
│ Version │  START   │  Package 1 Data  │  Package 2 Data  │ END  │
│(4 bytes)│ (0xF0F0F0)│                  │                  │(0x0F)│
└─────────────────────────────────────────────────────────────────┘
```

Flags:
- `ID`: `0xF0FF0F` - Structure message identifier
- `START`: `0xF0F0F0` - Data block start marker
- `END`: `0x0F0F0F` - Data block end marker

## Subscription-Aware Broadcasting

The `before` callback in `broadcastFloats()` receives a boolean indicating whether there are active subscribers:

```typescript
broadcaster.broadcastFloats(
    EngineAddresses.SPECTRUM,
    spectrum,
    (hasSubscribers) => {
        if (hasSubscribers) {
            // Only compute FFT when someone is listening
            spectrum.set(analyser.bins())
            analyser.decay = true
        }
    }
)
```

This optimization prevents expensive computations (FFT, waveform extraction) when no UI component displays the data.

## Address System

Addresses uniquely identify data streams using UUID + field composition:

```typescript
// Global engine addresses
export namespace EngineAddresses {
    export const PEAKS = Address.compose(UUID.Lowest).append(0)
    export const SPECTRUM = Address.compose(UUID.Lowest).append(1)
    export const WAVEFORM = Address.compose(UUID.Lowest).append(2)
}

// Per-device addresses (using device UUID)
const address = Address.compose(deviceUUID).append(fieldKey)
```

## Usage Example

### Broadcaster Side (Audio Worklet)

```typescript
// Create broadcaster
const broadcaster = LiveStreamBroadcaster.create(messenger, "engine-live-data")

// Register spectrum broadcast with conditional computation
const spectrum = new Float32Array(512)
broadcaster.broadcastFloats(
    EngineAddresses.SPECTRUM,
    spectrum,
    (hasSubscribers) => {
        if (hasSubscribers) {
            spectrum.set(analyser.bins())
        }
    }
)

// Every audio frame
process(inputs, outputs) {
    // ... audio processing ...
    broadcaster.flush()
}
```

### Receiver Side (Main Thread)

```typescript
// Create and connect receiver
const receiver = new LiveStreamReceiver()
receiver.connect(messenger.channel("engine-live-data"))

// Subscribe to spectrum data
const subscription = receiver.subscribeFloats(
    EngineAddresses.SPECTRUM,
    (spectrum) => {
        // Update UI with spectrum data
        drawSpectrum(spectrum)
    }
)

// Unsubscribe when component unmounts
subscription.terminate()
```

## Performance Considerations

1. **No allocations in audio thread**: All buffers are pre-allocated
2. **Lock-free reads/writes**: Uses `Atomics` for synchronization
3. **Conditional computation**: Skip expensive operations when no subscribers
4. **Animation frame timing**: Receiver runs at display refresh rate, not audio rate
5. **Shared memory**: Zero-copy data transfer between threads
