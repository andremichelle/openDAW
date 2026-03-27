# Monaco Editor Clipboard Fix

## Constraint

All fixes must be scoped to the editor components themselves. No bandaids in already working external components (buttons, dialogs, headers, etc.).

## Problem

Copy/paste (Cmd+C/V/X) in Monaco editors (Werkstatt, CodeEditor, Shadertoy) was broken.
Two separate issues were interacting:

### 1. ClipboardManager intercepts Monaco's native clipboard events

`ClipboardManager` registers global handlers on `document` for `paste` and `keydown`, and on the app `element` for `copy` and `cut`. When Monaco's clipboard events bubble up from its hidden textarea, ClipboardManager intercepts them:

- **`keydown` Cmd+C/X on `document`**: Calls `stopImmediatePropagation()` if DAW items are selected, killing the event before Monaco can act.
- **`paste` on `document`**: Intercepts all paste events. If a previous DAW copy left a `fallbackEntry`, it consumes the event even when the clipboard contains plain text meant for Monaco.
- **`copy`/`cut` on `element`**: Can overwrite Monaco's clipboard data with OPENDAW-encoded binary if DAW items are selected.

### 2. Previous workaround used navigator.clipboard API

The workaround (commit `126ec4f1`) overrode Cmd+C/V/X via `editor.addCommand()` to bypass the event-based clipboard entirely, using `navigator.clipboard.readText()`/`writeText()` directly. This avoided ClipboardManager but introduced a new problem: `navigator.clipboard.readText()` requires explicit `clipboard-read` permission in Chrome. When denied, paste silently failed (returned `""`).

### 3. Monaco focus desync after losing focus

Any element in the app can steal focus from Monaco's hidden textarea (header buttons, dialogs, other panels). After focus is stolen, clicking back into the editor restores typing but not Monaco's internal keybinding dispatch — shortcuts like Cmd+C/V/X stop working. The cursor is active and typing works, but Monaco's internal focus state is desynced.

## Fix

### ClipboardManager: respect text input focus (`ClipboardManager.ts`)

Added `Events.isTextInput(document.activeElement)` guard to all four event handlers (`copy`, `cut`, `paste`, `keydown`). When a text input element (Monaco's hidden textarea, chat input, etc.) has focus, ClipboardManager bails out and lets native clipboard handling work.

This matches the pattern already used by `ShortcutManager` and `Surface.dispatchGlobalKey`.

### Remove addCommand overrides (`CodeEditorPanel.tsx`, `CodeEditorPage.tsx`, `ShadertoyEditor.tsx`)

With ClipboardManager no longer intercepting, Monaco's native clipboard works. The `editor.addCommand()` overrides for Cmd+C/V/X are removed. Monaco handles clipboard through its own hidden textarea and native browser events.

### Clipboard abstraction: notify on failure (`clipboard.ts`)

Removed the silent `document.execCommand("copy")` fallback for `writeText` and the silent empty-string return for `readText`. Both now show a `RuntimeNotifier.info()` dialog when `navigator.clipboard` fails, so the user knows to check browser permissions.

### Disable EditContext API (`editContext: false`)

Monaco v0.53.0+ switched from a hidden `<textarea>` to the EditContext API for text input. This introduced focus tracking regressions ([#5081](https://github.com/microsoft/monaco-editor/issues/5081), [#5059](https://github.com/microsoft/monaco-editor/issues/5059)). The EditContext API causes Monaco's internal focus state to desync when external elements steal focus — the cursor still blinks and typing works, but keybinding dispatch breaks.

Setting `editContext: false` reverts to the pre-0.53 textarea-based input which has mature, well-tested focus handling.

Note: upgrading to Monaco 0.55.1 does NOT fix these focus issues.

#### Failed workaround attempts (before finding root cause)

1. **pointerdown + requestAnimationFrame + editor.focus()**: No-op when Monaco thinks it still has focus.
2. **onDidBlurEditorText + pointerdown capture + editor.focus()**: Same no-op issue.
3. **onDidBlurEditorText + pointerdown + setTimeout(0) + editor.focus()**: Same.
4. **onDidBlurEditorText + querySelector("textarea").blur()/focus()**: Works but fragile (depends on Monaco DOM internals).
5. **onDidBlurEditorText + activeElement.blur() + editor.focus()**: Works but requires user to click back into editor.

### Shared editor setup (`MonacoFactory`)

Extracted duplicated Monaco setup code into `MonacoFactory.create()` in `packages/app/studio/src/monaco/factory.ts`. All three editors now use this shared factory which handles: model creation, editor options, `editContext: false`, keyboard event isolation, and initial focus.

## Files changed

| File | Change |
|------|--------|
| `packages/lib/dom/src/clipboard.ts` | Remove fallbacks, show RuntimeNotifier on failure |
| `packages/studio/core/src/ui/clipboard/ClipboardManager.ts` | Add `isTextInput` guard to all handlers |
| `packages/app/studio/src/monaco/factory.ts` | New shared Monaco editor factory |
| `packages/app/studio/src/ui/code-editor/CodeEditorPanel.tsx` | Remove addCommand overrides, use MonacoFactory |
| `packages/app/studio/src/ui/pages/CodeEditorPage.tsx` | Remove addCommand overrides, use MonacoFactory |
| `packages/app/studio/src/ui/shadertoy/ShadertoyEditor.tsx` | Remove addCommand overrides, use MonacoFactory |

## Event flow after fix

### Clipboard (Cmd+C/V/X)

1. Keydown fires on Monaco's hidden textarea
2. Monaco handles clipboard natively via browser events
3. Event bubbles to container — `stopPropagation()` lets Cmd+C/V/X through (in `allowed` list)
4. Event reaches `document` — ClipboardManager sees `isTextInput(activeElement)` is true, bails out
5. Clipboard operation succeeds
