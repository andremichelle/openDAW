# Audio (Video) Chat Extension (#262)

**Doability:** ⭐⭐☆☆☆ (2/5) — WebRTC signaling infra exists for data, but media (audio/video) calling is a distinct, sizeable feature with real UX and privacy surface.
**Type:** ux
**Scope:** large

## What is asked
Add audio/video chat so collaborators working on the same project (live rooms) can talk faster instead of only text-chatting. Implied acceptance: some in-app way to start/join a voice or video call with the other people in the current live room.

## Current behaviour / relevant code
openDAW already has real-time collaboration infrastructure to build on:

- **Peer presence**: `packages/app/studio/src/service/RoomAwareness.ts` — wraps a Yjs `Awareness` instance, already tracks each connected user's `name`/`color`/`panel` and exposes `clientID`. This is the natural place to also broadcast a "call me" / SDP-offer signal per peer, or at minimum to know who is in the room to call.
- **WebRTC already in use, but for data, not media**: `packages/studio/p2p/src/AssetPeerConnection.ts` and `AssetSignaling.ts` set up `RTCPeerConnection`s for peer-to-peer sample/asset transfer, signaled over the existing Yjs WebSocket server (`packages/server/yjs-server/server.js`). This proves the signaling channel (WS server, already deployed) can carry SDP/ICE exchange; it does not currently negotiate any media (audio/video) tracks — `AssetPeerConnection` is data-channel only.
- **Text chat is already planned in detail** (not yet implemented, per `plans/live-room-chat.md`): a `ChatOverlay.tsx` floating panel driven by a `Y.Array<ChatMessage>` on the shared `Y.Doc`, wired in `StudioLiveRoomConnect.ts` and exposed via a `chatService` observable on `StudioService`. That plan's architecture decision (global overlay at the `App.tsx` level, not the per-screen panel system) is directly reusable for a call UI/indicator.
- No `getUserMedia`/`RTCPeerConnection` media-track code exists anywhere in the app packages today (checked `packages/app/studio`, `packages/studio/p2p`) — this would be new.
- `packages/app/studio/public/manuals/live-rooms.md` and `packages/app/studio/public/manuals/permissions.md` exist as user-facing docs for the current room/permission model — a media-chat feature would need entries here too (mic/camera permission prompts, on top of whatever else `permissions.md` already documents).

## Plan
1. **Reuse the signaling channel**, not the asset-transfer connection itself. Add a second, purpose-built `RTCPeerConnection` per remote peer for media (mirroring `AssetPeerConnection`'s pattern but negotiating `addTrack`/`ontrack` instead of a data channel), signaled through the same `AssetSignaling`-style topic-scoped messages over the Yjs WS server. Do not overload the asset transfer connection — keep concerns (file transfer vs. real-time media) on separate peer connections so one doesn't back-pressure the other.
2. **Presence-driven call initiation**: extend `RoomAwareness`'s state (or a sibling service) so a peer can signal "available for a call" / "ringing" without opening a full P2P connection preemptively for everyone in the room — mesh WebRTC (every peer connects to every peer) is the natural fit for small rooms but does not scale past a handful of participants; cap or warn past N peers.
3. **UI**: follow the `plans/live-room-chat.md` precedent — a global overlay (not a per-screen panel), sibling to `ChatOverlay` in `App.tsx`, showing connected peers with mute/camera-toggle controls and speaking indicators. If both text chat and a/v chat ship, consider unifying them into one "Room Chat" overlay with tabs/modes rather than two separate floating panels competing for the same screen edge.
4. **Permissions**: `getUserMedia` requires a user gesture and HTTPS/secure context (already true — the app requires COOP/COEP + HTTPS for AudioWorklet/SAB anyway). Add explicit mic/camera permission UX distinct from the existing sample/project permission model in `permissions.md`.
5. **Audio routing conflict**: openDAW's own audio engine already owns the `AudioContext`/AudioWorklet graph for DSP. A voice-chat audio stream must not interfere with that graph — likely needs its own separate `AudioContext` (chat audio) rather than being routed through the DAW's engine graph, to avoid coupling call audio to playback state (play/stop/tempo) or introducing latency-sensitive contention with the real-time DSP path.

## Risks / open questions
1. **Mesh scaling**: WebRTC mesh (every peer connects to every peer) is the low-effort option but degrades quickly beyond ~4-6 participants (each peer uploads N-1 streams). An SFU (media server) fixes this but is a much larger infra addition (new server component, likely paid/hosted, e.g. LiveKit/mediasoup) — worth deciding target room size before committing to mesh.
2. **Bandwidth/privacy stance**: project README explicitly markets "No Tracking," "No Data Mining" — a video feature should be clearly P2P (no server-side media relay/recording) to stay consistent with that positioning; needs explicit confirmation from the maintainer since it's a product-values question, not just technical.
3. **Overlap with text chat plan**: if `plans/live-room-chat.md` ships first, decide whether audio/video chat extends that same overlay or is a separate feature — recommend sequencing text chat first (smaller, already fully planned) and building a/v as a follow-on using the same peer-list/signaling scaffolding.
4. **Mobile/webview support**: the studio is currently desktop-gated (`main.ts` blocks mobile) — camera/mic UX on desktop browsers only, simplifying scope somewhat.
