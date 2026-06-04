# External btn-comment-mode-click

- **status:** ENV · **priority:** ENV
- **occurrences:** 1 · **ids:** [957]
- **assessment:** document.getElementById(...).click null - external/injected script.
- **action:** Confirm not first-party; ignore-list.

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
