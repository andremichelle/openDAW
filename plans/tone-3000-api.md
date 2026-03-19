# Tone 3000 API Integration for NeuralAmp

## Goal

Allow users to browse and load NAM models from [Tone 3000](https://www.tone3000.com) directly inside the NeuralAmp device editor, using the **Select Flow** API.

## Architecture: Select Flow + Popup

The Tone 3000 **Select Flow** is a redirect-based mechanism (like OAuth). We open it in a popup window, and use a local callback page + `postMessage` to get the result back into the editor.

```
Editor                     Popup (new tab)                  Tone 3000
  │                            │                               │
  │── window.open() ──────────►│                               │
  │                            │── redirect ──────────────────►│
  │                            │                               │ (user logs in,
  │                            │                               │  browses tones,
  │                            │                               │  selects one)
  │                            │◄── redirect with ?tone_url ──│
  │                            │                               │
  │◄── postMessage(tone_url) ──│                               │
  │                            │── window.close() ────────────►│
  │                            │                               │
  │── fetch(tone_url) ────────────────────────────────────────►│
  │◄── { tone, models[] } ────────────────────────────────────│
  │                                                            │
  │── fetch(model.model_url) ─────────────────────────────────►│
  │◄── .nam file contents ────────────────────────────────────│
  │                                                            │
  │── create NeuralAmpModelBox & load ──►                      │
```

## Steps

### Step 1: Callback Page

Create a minimal HTML page served by the app (e.g. `/tone3000-callback.html` in `packages/app/studio/public/`).

This page:
1. Reads `tone_url` from `window.location.search`
2. Sends it to `window.opener` via `postMessage`
3. Closes itself

```html
<!DOCTYPE html>
<html>
<head><title>Tone 3000</title></head>
<body>
<p>Loading...</p>
<script>
  const params = new URLSearchParams(window.location.search);
  const toneUrl = params.get("tone_url");
  if (toneUrl && window.opener) {
    window.opener.postMessage({ type: "tone3000-select", tone_url: toneUrl }, "*");
  }
  window.close();
</script>
</body>
</html>
```

### Step 2: Tone 3000 Service

Create a small service/utility (e.g. `Tone3000Service.ts` in `packages/app/studio/src/service/` or alongside the NeuralAmp editor) that encapsulates the flow:

- `selectTone(): Promise<{ tone: Tone, models: Model[] }>`
  1. Computes `redirect_url` = `${window.location.origin}/tone3000-callback.html`
  2. Opens popup: `window.open(https://www.tone3000.com/api/v1/select?app_id=openDAW&redirect_url=${redirect_url}&gear=amp_pedal_full-rig&platform=nam)`
  3. Listens for `message` event with `type === "tone3000-select"`
  4. Fetches the `tone_url` (no auth needed, pre-signed)
  5. Returns the tone + models data
  6. Cleans up listener

- `downloadModel(modelUrl: string): Promise<string>`
  1. Fetches the model URL (pre-signed, no auth)
  2. Returns the `.nam` file content as text

### Step 3: Editor Integration

In `NeuralAmpDeviceEditor.tsx`, add a second button next to the existing file-browse button:

- **Icon**: Use a cloud/download icon or the Tone3000 logo
- **onClick**: Calls `Tone3000Service.selectTone()`
- On success:
  1. Presents a model picker if the tone has multiple models (standard, lite, feather, nano), or auto-selects if only one
  2. Downloads the selected model via `Tone3000Service.downloadModel(model.model_url)`
  3. Creates a `NeuralAmpModelBox` (same pattern as `browseModel()` — SHA256 for UUID, dedup by hash)
  4. Points `adapter.box.model.refer(modelBox)`

The existing `browseModel()` function already shows the exact pattern for creating and loading a model. The Tone 3000 flow just replaces the file picker with a remote fetch.

### Step 4: Model Size Selection (if multiple models)

A tone can have multiple models in different sizes (standard, lite, feather, nano). We need a simple selection UI:

- If 1 model → auto-load
- If multiple → show a small dialog/dropdown letting user pick (show size label + name)
- Default to "standard" if available

## API Details

### Select Flow Endpoint
```
GET https://www.tone3000.com/api/v1/select
  ?app_id=openDAW
  &redirect_url={callbackUrl}
  &gear=amp_pedal_full-rig    (optional: filter by gear type)
```

### Select Flow Response (fetched from `tone_url`)
```typescript
interface Tone {
  id: number
  title: string
  description: string | null
  gear: "amp" | "full-rig" | "pedal" | "outboard" | "ir"
  platform: "nam" | "ir" | "aida-x" | "aa-snapshot" | "proteus"
  sizes: ("standard" | "lite" | "feather" | "nano" | "custom")[]
  models_count: number
  user: { username: string }
}

interface Model {
  id: number
  name: string
  size: "standard" | "lite" | "feather" | "nano" | "custom"
  model_url: string  // pre-signed, no auth needed
  tone_id: number
}

// tone_url returns:
type SelectResponse = Tone & { models: Model[] }
```

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/app/studio/public/tone3000-callback.html` | **New** — callback page |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/Tone3000Service.ts` | **New** — select flow + fetch logic |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.tsx` | Add Tone 3000 browse button |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.sass` | Style the new button |

## Considerations

- **No app_id registration needed?** — We need to check if Tone 3000 requires registering an `app_id` or if any string works. May need to register "openDAW" with them.
- **CORS** — The `tone_url` and `model_url` are pre-signed URLs from Tone 3000's CDN. They should be CORS-friendly for browser fetch. If not, we may need to proxy through our own server or use a different approach.
- **Popup blockers** — The `window.open()` must be called directly from a user click handler (synchronous), otherwise browsers will block it. The button's `onClick` is a direct user gesture, so this should work.
- **Offline / local-only** — The existing file-browse flow remains as the primary way to load local `.nam` files. Tone 3000 is an additional option for users who want to browse a library.
- **Model label** — Use `tone.title + " — " + model.name` or similar as the `NeuralAmpModelBox.label`.
