# Traffic Watch — Upload/Download Rate in RoomStatus

## Goal

Show real-time upload and download rates in the `RoomStatus` bar when a user is transferring assets (samples, soundfonts) to/from peers in a live room.

## Current State

- `RoomStatus` shows room name + connected users
- P2P transfers happen via WebRTC data channels in 64KB chunks
- `AssetServer` sends chunks (upload) with backpressure
- `PeerAssetProvider` receives chunks (download) and reports progress as chunk fraction
- No byte-level throughput tracking exists anywhere in the pipeline

## Architecture

### Where bytes flow

```
Upload:  AssetServer  → sendWithBackpressure() → RTCDataChannel → remote peer
Download: RTCDataChannel → PeerAssetProvider.#onDataChannelMessage() → reassembly
```

Both paths handle `ArrayBuffer` chunks of known size (64KB + 21-byte header). Counting bytes at these points gives accurate throughput.

### TrafficMeter (new, in `@opendaw/studio-p2p`)

A lightweight counter that tracks bytes over a sliding window:

```typescript
class TrafficMeter {
    record(direction: "up" | "down", bytes: number): void
    get uploadRate(): number   // bytes/sec, computed over last N seconds
    get downloadRate(): number // bytes/sec
    subscribe(observer: Observer<TrafficMeter>): Subscription
}
```

- Uses a ring buffer of per-second byte totals (e.g., last 5 seconds)
- Ticks on a 1-second interval (or on-demand when queried)
- Notifies subscribers at most once per second when any transfer is active
- Rate drops to 0 when idle — stops notifying

### Instrumentation points

1. **Upload** — `AssetServer.#onChannelMessage()` / `sendWithBackpressure()`:
   After each chunk is sent, call `trafficMeter.record("up", chunk.byteLength)`

2. **Download** — `PeerAssetProvider.#onDataChannelMessage()`:
   After each chunk is received, call `trafficMeter.record("down", data.byteLength)`

### Exposing to UI

`P2PSession` owns the `TrafficMeter` and passes it to both `AssetServer` and `PeerAssetProvider`.

`P2PSession` exposes a readonly `trafficMeter` getter.

In `StudioLiveRoomConnect.connectRoom()`, after creating `P2PSession`, pass `p2pSession.trafficMeter` to the service layer so `RoomStatus` can subscribe.

The `TrafficMeter` tracks **local** traffic only (this client's own uploads/downloads), not other peers.

Plumbing: Add `trafficMeter: Observable<TrafficMeter>` to `StudioService`, following the same pattern as `roomAwareness` (set on connect, clear on disconnect).

### TrafficWatch component (new)

Separate component at `packages/app/studio/src/ui/TrafficWatch.tsx` + `.sass`, rendered inside `RoomStatus` after the user list.

```
[Room 'name'] [👤 User1] [👤 User2] [↑ 2.4 MB/s  ↓ 850 KB/s]
```

- Accepts `TrafficMeter` via construct, subscribes to it
- Only visible when at least one rate is non-zero
- Format: `↑ {rate}` for upload, `↓ {rate}` for download, or both
- Human-readable units: KB/s, MB/s (auto-scale)
- Hidden when idle (~2 seconds after rates drop to 0)
- Same font size as RoomStatus (0.625rem)
- Upload arrow `↑` and download arrow `↓` as plain text
- Subtle color to not compete with room label and user dots

## Implementation Steps

- [ ] Step 1: Create `TrafficMeter` class in `@opendaw/studio-p2p`
- [ ] Step 2: Instrument `AssetServer` and `PeerAssetProvider` to record bytes
- [ ] Step 3: Expose `TrafficMeter` from `P2PSession`
- [ ] Step 4: Plumb through `StudioLiveRoomConnect` → `StudioService`
- [ ] Step 5: Subscribe in `RoomStatus` and render upload/download rates

## Considerations

- **Performance** — TrafficMeter should be cheap. Ring buffer of 5 ints per direction, one timer. No allocations on the hot path.
- **Multiple concurrent transfers** — Rates aggregate across all active data channels. One number for total upload, one for total download.
- **Format helper** — `formatRate(bytesPerSec: number): string` → "1.2 MB/s", "340 KB/s", etc.
- **No transfer active** — Traffic element is hidden (not "0 KB/s").
- **Timer cleanup** — The 1-second tick interval must be terminated when `P2PSession` terminates.
