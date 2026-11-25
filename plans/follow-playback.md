# Follow Playback in Live Rooms

Issue #325. Supersedes the design in PR #326 (Gabriel Vigliensoni), keeps its anchor idea.

## Goal

People in a live room listen to the same project together, roughly in step, without sample accuracy. One person
plays, others follow. Nothing changes for anyone who does not follow.

## User experience

1. Clicking a name in the room status bar opens a dropdown. First entry: **Follow Playback** (or **Stop Following**).
   More entries can join later.
2. The followed person gets a clock icon next to their name. Followers get a small follow icon.
3. Following resolves to the end of a chain: following someone who follows Anna means following Anna. An entry that
   would close a loop back to you is disabled.
4. While following, the own transport is disabled entirely: play, stop, record, loop toggle, ruler click and drag,
   marker jumps, clip launching and the matching shortcuts.
5. Following ends via the dropdown, or automatically when the person at the end of the chain changes (someone in the
   chain stops following or follows someone else), or when the followed person (or anyone in the chain) leaves the
   room, when the own connection to the room ends, or when the room closes. In every case all transport controls come
   back at once, at the current position, stopped or playing as it was. "Leaves" includes a lost connection: the
   followed person's awareness state disappearing ends the follow, no matter how it disappeared.
   The lock is owned by the follow lifecycle, which is owned by the room connection, so tearing down the room
   always releases it. Tests cover each of these exits.
6. Clicking Follow while the other person plays starts playback right away at their current position.

## What travels

Only play state and position. Everything else is shared already through the project:

- tempo map and tempo automation (each engine plays the same curve, so nothing to sync)
- loop area, signature, markers

No periodic messages, no drift correction. Each engine runs freely after the start. We wait for reports.

Engine restarts need no special case. A restarting engine stops. On the leader that stop is forwarded like any
other, so followers stop too. On a follower it simply stops and picks up again with the leader's next transport
message.

## Messages

Over the signaling server the call already uses (`/signaling`, topic `follow:<room>`), not the project Yjs doc.
Followers are announced in awareness (`follow: <peerId of leader>`), so a person knows whether anyone follows them.

1. `request` (follower → leader): `{type, from, to, nonce}`
2. `state` (leader → follower, answer to request): `{type, from, to, nonce, playing, position, outputLatency}`
3. `transport` (leader → all followers, only when followed): `{type, from, playing, position, outputLatency}` sent on
   start, jump and stop.

Nothing is sent by a person nobody follows.

## Position math

The engine already reports exact transport anchors (`EngineFacade.subscribeTransportAnchors`, `TransportAnchor`:
`kind start | jump | stop`, `contextTime`, `position`). The leader computes its current position from the latest
anchor: `anchor.position` plus `context.currentTime - anchor.contextTime` converted through `project.tempoMap`
(`ppqnToSeconds`, `secondsToPPQN`), wrapped into the loop area when looping.

Follower on `state` or `transport`:

1. `transit = rtt / 2` for an answer to its own request (rtt measured with the nonce). For pushed `transport`
   messages use the last measured `rtt / 2`.
2. `elapsed = transit + startAllowance + own.outputLatency - leader.outputLatency` (the follower renders ahead by
   its own output latency and behind by the leader's, so both hear the same moment). No start allowance when the
   follower is already playing (a jump).
3. `target = position advanced by elapsed through the tempo map`, wrapped into the loop area.
4. `setPosition(target)` and `play()` through the follow handle.

`startAllowance` is the time from `play()` to the engine's own `start` anchor. Measure it from the follower's last
start (anchor `contextTime` minus call time), default 50 ms before the first measurement.

## Single transport pipeline

All transport commands already go through `EngineFacade` (`service.engine`). No UI code calls `EngineWorklet` directly.
`EngineWorklet` is replaced on every engine restart, `EngineFacade` survives, so the gate lives there.

```typescript
interface TransportLock extends Terminable {
    play(): void
    stop(): void
    setPosition(position: ppqn): void
}

class EngineFacade {
    lockTransport(): TransportLock          // only one at a time, terminate releases
    get transportLocked(): ObservableValue<boolean>
    subscribeTransportCommands(observer: Observer<TransportCommand>): Subscription
}
```

- While locked, `play`, `stop`, `setPosition`, `prepareRecordingState`, `stopRecording`, `scheduleClipPlay` and
  `scheduleClipStop` called on the facade are ignored. One check, inside the facade.
- UI controls read `transportLocked` for their disabled look only. They contain no follow logic.
- The leader side does not hook buttons. The follow service listens to the engine's transport anchors
  (start, jump, stop) and forwards them to followers. That catches every path: buttons, shortcuts, ruler, markers,
  console commands, recording restarts.

Call sites that end up behind the gate without changes (current count): StudioShortcutManager 6, Project 4,
TapTempo 3, TransportGroup 3, ClipsHeader 2, ClipPlaybackButton 2, NoteEditor 2, ContentEditor 2, PianoModePanel 2,
StudioService 2 (console), RecordingSession, MarkerTrackBody, RegionsArea, ValueEditor, TimeAxis, NoteFall,
SampleEditorPage, DeviceDialog.

Check per call site that an ignored call leaves no half state (for example a recording session that prepared
captures before calling the engine).

## Components

1. `EngineFacade`: `lockTransport`, `transportLocked`, gate in the transport methods.
2. `FollowService` (app/studio/src/follow): owns the signaling connection for the room, the request/answer with rtt,
   the awareness field, chain resolution, the lock while following, forwarding anchors while followed.
   Created and owned by `StudioLiveRoomConnect` like `CallService`.
3. `RoomStatus`: name dropdown (MenuButton) with Follow Playback, clock icon on the followed person, follow icon on
   followers.
4. Disabled look for transport controls, ruler and clip launch buttons from `transportLocked`.
5. Manual: live-rooms.md section "Follow Playback". Privacy page: one sentence that play state and position are
   sent to people following you.

## Phases

1. Gate in `EngineFacade` with tests (locked calls ignored, lock handle works, release restores). DONE: `TransportLock`
   in Engine.ts, `lockTransport` and `transportLocked` on the facade, `stopRecording` and `panic` stay open as safety
   exits, `RecordingSession.start` refuses while locked so no capture gets armed. The follow service must end a
   running recording before it locks.
2. `FollowService` with messages, chain resolution and position math, tests for the math (tempo automation, loop
   wrap, chain and loop detection) with a fake signaling. DONE in `app/studio/src/follow`: `FollowTypes`,
   `FollowMath`, `FollowService` (host and channel injected), `StudioFollowHost` (engine anchors, tempo map, loop
   area, measured start delay). Clients are addressed by their awareness client id. `CallSignaling` became the
   generic `service/RoomSignaling` shared by call and follow. Any change of the chain's end ends following: a
   middle person's update and a departure can arrive in either order, this rule gives the same result for both.
3. UI: dropdown, icons, disabled transport. DONE: `FollowService` created per room in `StudioLiveRoomConnect`
   (own `RoomSignaling` on `follow:<room>`), `service.followService`. Name dropdown in `RoomStatus` ("Follow
   <name>'s Playback", "Stop Following" on the followed name and on the own name while following), metronome icon on
   the followed person, headphone icon on followers. Record, play and stop dim while locked. The loop toggle stays
   active: the loop area is shared project data, not engine transport. Ruler, markers, clip launch and shortcuts are
   silenced by the gate without their own disabled look. Manual and privacy page updated.
4. Two tabs on localhost, then two machines. Two tabs DONE (Chrome): follow, lock (record/play/stop dimmed, own
   play ignored), play/stop/pause forwarded, Stop Following, leader leaving. Found and fixed: the studio and the
   project each own an `EngineFacade` on the same worklet, the host locks both. Default start delay is one render
   block (measured 2.7 ms, the old 50 ms default started followers ahead). Then fixed and retested: every answer and push
   carries the sender's clock, the follower estimates the leader's clock offset from the fastest of 4 requests
   and measures each message's real transit (offset went from ±30-45 ms to a steady ~12 ms). Seeks while stopped
   are forwarded, including the jump back of Stop. The page leaves the room's awareness on pagehide, so leaving is
   noticed within seconds (y-websocket only does this for node). Two machines still open.

## Open questions

1. Recording while followed: does a follower hear the leader's count-in? First version: count-in is not forwarded,
   followers start at the recording start position.
2. Leader seeks while stopped: forward the new position so followers see the same cursor, or only forward on play.
   First version: only on play.
