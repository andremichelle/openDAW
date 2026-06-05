# External btn-comment-mode-click

- **status:** FIXED (classified external, generic) · **priority:** ENV
- **occurrences:** 1 · **ids:** [957]
- **assessment:** `document.getElementById('btn-comment-mode').click()` null deref - external/injected script (`btn-comment-mode` absent from all source; stack is document-inline `@https://opendaw.studio/:4:46` / `global code@.../:28:3`, not our bundle).
- **fix:** Generalised `#looksLikeExtension` in `ErrorHandler.ts` (not a per-id pattern): our own frames always reference a script *module* file (`.js`/`.mjs` in prod, `.ts`/`.tsx`/`.jsx` served by Vite in dev, via `ModuleUrlPattern`); an injected inline script runs from the bare document URL (`.../:line:col`). So a stack that has source URLs but **no** module-file frame did not originate in our code → classified external (warning) instead of crashing. Catches any injected/inline page script, not just this id. Conservative: a mixed stack with any real module frame is treated as ours (cannot mask a genuine first-party error). Verified across prod/dev/injected/mixed cases. (`index.html` has no inline `<script>`, so a document-URL frame is reliably foreign.)

[< back to index](error-triage.md)

## Reports

### TypeError: null is not an object (evaluating 'document.getElementById('btn-comment-mode').c
- **occurrences:** 1 · **ids:** [957] · **span:** 2026-05-14->2026-05-14 · **builds:** 1 · **browsers:** ?/macOS
- **stack:**
  - `@https://opendaw.studio/:4:46`
  - `global code@https://opendaw.studio/:28:3`

## Investigation (root cause + recommended fix)

**Root cause:** External/injected script. `btn-comment-mode` does not exist anywhere in openDAW source. A third-party script (bookmarklet / browser extension / userscript) ran `document.getElementById('btn-comment-mode').click()` on the page; the element was absent so `getElementById` returned `null` and the `.click` access threw.

**Evidence:** Repo grep for `btn-comment-mode` returns only these triage `.md` files, zero source/HTML/CSS hits. The stack is `@https://opendaw.studio/:4:46` and `global code@https://opendaw.studio/:28:3`, i.e. inline top-level code on the document (line 4 / 28 of the HTML document), not our bundled module URLs. This is the classic injected-`<script>` signature.

**Recommended fix:** Add `"btn-comment-mode"` to `ExtensionPatterns` in `packages/app/studio/src/errors/ErrorHandler.ts:10` (or a dedicated `ThirdPartyAppPatterns` entry). `#looksLikeExtension` (`ErrorHandler.ts:36`) already tests `error.message?.includes(pattern)`, so the message `null is not an object (evaluating 'document.getElementById('btn-comment-mode').click')` would be classified as external and shown the "external code" warning instead of crashing the app. (Note: the existing non-URL-stack heuristic at `ErrorHandler.ts:45` may already catch some of these, but the document-inline URLs here are same-origin, so the explicit pattern is the reliable fix.)
