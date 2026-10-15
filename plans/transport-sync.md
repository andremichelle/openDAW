# Transport Sync: Shared Listening in Live Rooms

## Goal

Give Live Room participants the sensation of listening together — same section, roughly the
same position, roughly in phase — without attempting sample-accurate synchronized playback.
Model: Strudel/Flok, not Ableton Link. No continuous clock negotiation; every client
independently recomputes its own position from a shared anchor.

---

## TransportAnchor

The shared state is a small plain object, deliberately not a running clock:

```typescript
type TransportAnchor = {
    playing: boolean
    epoch: number          // Date.now() when this anchor was set
    anchorPosition: ppqn   // timeline position at that instant
    bpm: bpm
}
```

Every client derives its own position fresh from these four numbers instead of running a
local counter:

```typescript
currentPosition = anchorPosition + (Date.now() - epoch) * (bpm / 60)
```

`TransportAnchor.recompute(anchor, now)` implements this.

## TransportChannel

`TransportChannel` is the transport-agnostic interface (`publish` / `subscribe`) the sync
service talks to. Two implementations:

- **`TransportBroadcastChannel`** — same-origin `BroadcastChannel`, zero networking. Used to
  validate the recompute formula and quantized-rejoin behavior with two local tabs before any
  room/Yjs involvement.
- **`TransportYjsChannel`** — wraps a `transport` `Y.Map` kept as a sibling of the existing
  `boxes` map on the room's `Y.Doc`, never entangled with the structural project-edit CRDT.
  This is the real live-room path; `StudioLiveRoomConnect` attaches it on room join.

## TransportSyncService

Owned by `StudioService` (`service.transportSync`), outlives any single room. `attach(channel)`
swaps in a channel when one becomes available and returns a `Terminable` to detach.

```typescript
class TransportSyncService implements Terminable {
    get follow(): DefaultObservableValue<boolean>
    get rejoinGrid(): DefaultObservableValue<RejoinGrid>   // "bar" | "beat"

    attach(channel: TransportChannel): Terminable
    publishLocal(playing: boolean): void
}
```

### Ownership: last-action-wins

Whoever presses play/stop — or seeks — broadcasts a fresh anchor via `publishLocal`; it simply
overwrites the previous one. No leader election. Hooked from `StudioShortcutManager` (play/stop
shortcuts) and `TransportGroup` (play/stop/loop buttons).

### Opt-in per client

A "follow room playback" toggle (headphone icon) in `TransportGroup`, disabled while outside a
room. Nobody's transport gets hijacked without asking. Following is itself broadcast — see
Room Awareness below — so everyone can see who's listening along.

### Quantized rejoin

On receiving a new/changed anchor while `follow` is on, don't hard-cut: round to the next bar
or beat boundary (`rejoinGrid`, configurable via right-click on the follow toggle) before
applying, so a late update sounds like a rejoin, not a stutter. If playback is currently
stopped, or drift is small, it snaps immediately instead of waiting for a grid line.

### Tolerance, not precision

A 500ms interval re-checks drift against the latest anchor while playing and following; only
schedules a rejoin if drift exceeds ~175ms. No continuous phase correction.

### Streaming local seeks

`publishLocal` alone only covers play/stop. A local seek mid-playback (dragging the timeline
ruler, jump-to-grid, piano-roll click) also needs to re-anchor the stream, otherwise followers
keep extrapolating from the pre-seek position until the next stop/play.

`engine.position` ticks continuously during ordinary playback (every engine state message from
the audio thread), not just on seeks, so the service can't simply republish on every position
change — that would flood the channel. Instead it tracks where playback should naturally be
since the last tick and only republishes when the actual position diverges from that
expectation by more than the drift tolerance — i.e. a genuine discontinuity. Broadcasts are
coalesced to once per animation frame (`deferNextFrame`, the same pattern `RoomAwareness` uses
for its own broadcasts), so a click-drag seek doesn't spam the channel either.

This local-seek detection is guarded against the service's own remote-driven `setPosition`
calls (a follower snapping/rejoining to someone else's anchor) via an internal
`#applyingRemote` flag — otherwise following would immediately echo back as a new "local seek."

---

## Room Awareness: who's following

`RoomAwareness` gained a `follow: boolean` field alongside the existing `name` / `color` /
`panel`, broadcast the same way (batched via `deferNextFrame` into the Yjs awareness protocol).
`StudioLiveRoomConnect` keeps it in sync with `service.transportSync.follow` for the duration
of the room session. `RoomStatus` renders a small headphone icon next to any user whose
`follow` flag is set.

---

## Where this lives

- `packages/app/studio/src/service/transport-sync/` — `TransportAnchor`, `TransportChannel`,
  `TransportBroadcastChannel`, `TransportYjsChannel`, `TransportSyncService`
- `packages/app/studio/src/service/StudioService.ts` — owns `transportSync`
- `packages/app/studio/src/service/StudioLiveRoomConnect.ts` — attaches the Yjs channel on join
- `packages/app/studio/src/service/StudioShortcutManager.ts` — play/stop shortcuts publish
- `packages/app/studio/src/service/RoomAwareness.ts`, `src/ui/RoomStatus.tsx` — follow indicator
- `packages/app/studio/src/ui/header/TransportGroup.tsx` — follow toggle, rejoin-grid menu
- `packages/app/studio/src/ui/components/Checkbox.tsx` — gained an optional `disabled` prop,
  used to disable the follow toggle outside a room

## Validated

Two tabs, same room, `follow` enabled on one: play/stop, mid-playback seeking (ruler drag), and
the bar/beat rejoin-quantization menu all keep the follower in sync. `tsc --noEmit` clean at
every commit in the implementation series.

## Open questions

- Whether bar- or beat-level quantization feels better is genre/tempo dependent — currently a
  per-client menu choice rather than a fixed default; worth revisiting with more real usage.
- Drift tolerance (175ms) is a starting guess validated informally on localhost; untested over
  a real high-latency WAN link between distant participants.
