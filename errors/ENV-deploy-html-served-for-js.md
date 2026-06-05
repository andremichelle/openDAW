# Deploy html-served-for-js

- **status:** FIXED (infra-mitigated, stale reports) · **priority:** ENV
- **occurrences:** 2 · **ids:** [160, 237]
- **assessment:** Stale/misrouted release returning index.html for a JS module ('got <'). Same stale-deploy family as [[ENV-network-chunk-load]]. Both reports are old (2025-09-24, 2025-10-16) and predate the boot `checkUpdates`/`UpdateMessage` mitigation (2025-10-15) and the 24h release retention. No recurrence in ~8 months. No runtime change shipped.

[< back to index](error-triage.md)

## Reports

### SyntaxError: expected expression, got '<'
- **occurrences:** 2 · **ids:** [160, 237] · **span:** 2025-09-24->2025-10-16 · **builds:** 2 · **browsers:** Firefox/Win, Firefox/macOS

## Investigation (root cause + recommended fix)

**Root cause:** Stale/misrouted deploy. The SPA fallback (server returns `index.html` for any unmatched path) served HTML where the browser expected a JS module, so the parser hit `<` from `<!doctype html>`. This is the same stale-release family as ENV-network-chunk-load: a chunk URL from an old build no longer exists, and the host's catch-all route returns `index.html` instead of a 404. Firefox-only wording `expected expression, got '<'` (Chrome says `Unexpected token '<'`).

**Evidence:** Both reports have empty stack and empty logtail (the error fires at module-parse time, before the app boots / before `LogBuffer` records anything), which is the signature of a top-level script that resolved to HTML. Environmental, not a code bug.

**Recommended fix:** Same reload-prompt path as the chunk-load family. Because these arrive as a parse-time `error` event (an `ErrorEvent`, not a promise rejection) with `message === "expected expression, got '<'"` / `"Unexpected token '<'"`, extend `ErrorHandler.#tryIgnore` (`ErrorHandler.ts:68`) to detect these messages on the `ErrorEvent` branch and trigger the "reload to update" prompt (`location.reload()`) rather than the crash dialog. Tightening the host config to return real 404s for missing `/releases/*` assets would prevent the misrouting at the source.
