# Live Collaboration Fixes

A running log of bugs and fixes in the P2P asset transfer and live collaboration layer. Add new entries at the top so the most recent context is easiest to find.

---

## RTCDataChannel `send()` on closed channel

### Symptom

Production error surfaced via `ErrorHandler`:

```
InvalidStateError: Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'
  at AssetPeerConnection.sendWithBackpressure
  at AssetServer.#onChannelMessage
```

Visible in the logs as ICE/connection `disconnected` arriving a few milliseconds before the error, after the server had spent many seconds preparing a large soundfont.

### Problem

`AssetServer.#onChannelMessage` serves an asset over a WebRTC data channel in this order:

1. `readSoundfont(uuid)` from OPFS
2. `AssetZip.packSoundfont(...)` (JSZip)
3. Send `TransferStart`
4. Loop: send each chunk
5. Send `TransferComplete`

Steps 1 and 2 are genuinely slow for large assets. For a 261 MB soundfont the read + zip pack took ~16 seconds. Any RTC disconnect in that window leaves the data channel closed when step 3 runs.

`AssetPeerConnection.sendWithBackpressure` did not check `channel.readyState` before calling `channel.send(data)`. Two failure modes:

- **Direct throw**: channel already closed when we reach `send()` → throws `InvalidStateError` synchronously.
- **Stuck forever**: buffered amount above the high watermark when the channel closes → `onbufferedamountlow` never fires, the awaited promise never resolves, and the transfer coroutine leaks.

The contributing factor (not the bug itself but what made it frequent): when several peers request the same large asset simultaneously, the server spawns concurrent OPFS reads + zip packs. Each holds its own lifecycle race independently of the others, widening the total window where a close can land in an unguarded send.

### Fix

Two small, local changes. No public API change outside the `p2p` package.

**`AssetPeerConnection.sendWithBackpressure`** — returns `Promise<boolean>` (`true` = sent, `false` = channel was not in `open` state):

- Guard `channel.readyState === "open"` at entry.
- During the backpressure wait, also listen for `close` and `error` (with `{once: true}` and explicit cleanup) so a mid-wait close resolves the promise instead of hanging.
- Re-check `readyState` after the wait; return `false` if the state changed.
- Only then call `channel.send(data)`.

**`AssetServer.#onChannelMessage`** — checks the boolean at all three send sites (`TransferStart`, each chunk, `TransferComplete`). On `false` it logs a debug line and `return`s cleanly, so the remaining chunks are skipped and the error no longer bubbles up to `ErrorHandler`.

### Reproduction

1. Join a Live Room with two peers. Let A be the server, B the requester.
2. On A, load a large soundfont (hundreds of MB). The failing case in production was 261 MB.
3. On B, create a Soundfont Device that references A's asset so B issues a P2P asset-request.
4. While A is in `readSoundfont` + `packSoundfont` (many seconds), force A's RTC connection to drop — toggle Wi-Fi, VPN, or simulate packet loss in `chrome://webrtc-internals`.
5. When A's pack finishes, the old code throws `InvalidStateError`; the fixed code logs `channel closed before transfer started for <uuid>` and returns.

Synthetic reproduction for tests: spy on `AssetZip.packSoundfont` to return a controllable promise, close the mock channel before resolving it, and assert `channel.send` is never called. See `packages/studio/p2p/src/__tests__/AssetServer.test.ts` and `AssetPeerConnection.test.ts`.

### What to watch for next time

- Any `await`able step between receiving a request and calling `channel.send()` is a new window where the channel can close. If you add caching, metadata lookup, or progress events, re-check `readyState` after each await.
- If a new send site is added, route it through `sendWithBackpressure` and honor the boolean. Direct `channel.send(...)` calls bypass the guard and will reintroduce the bug.
- `onbufferedamountlow` will silently never fire on a closed channel. Any new backpressure-style wait needs a `close`/`error` listener paired with the resolve path.
- Concurrent transfers of the same asset to multiple peers are expected — they multiply the chance that any one of them hits a disconnect during prep. Keep per-connection state strictly per-connection.
