# Media element — "no supported source was found"

- **status:** OPEN (ENV, low signal — no stack) · **priority:** ENV
- **occurrences:** 1 · **ids:** [1022]
- **assessment:** `NotSupportedError: Failed to load because no supported source was found.` with an empty stack — a media element (`<audio>`/`<video>`) `play()`/load rejection surfaced as an unhandled error. Linux Chrome without proprietary codecs is the classic cause. Without a stack there is nothing to fix in-app yet; if it recurs, find which media element the app creates (video overlays / promo assets are candidates) and attach a rejection handler with a friendly message there.

[< back to index](error-triage.md)

## Reports

### NotSupportedError: [DOMException] Failed to load because no supported source was found.
- **occurrences:** 1 · **ids:** [1022] · **span:** 2026-07-03 · **builds:** 1 (169f7f25) · **browsers:** Chrome/Linux · **stack:** (empty)
