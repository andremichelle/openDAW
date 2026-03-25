# Tone 3000 API Integration for NeuralAmp

## Goal

Allow users to browse and load NAM models from [Tone 3000](https://www.tone3000.com) directly inside the NeuralAmp device editor, using the **Select Flow** API.

## Architecture: Select Flow + Popup

The Tone 3000 **Select Flow** is a redirect-based mechanism (like OAuth). We open it in a **popup window** (not a new tab), and use a local callback page + `localStorage` events to get the result back into the editor.

```
Editor                     Popup (popup window)             Tone 3000
  │                            │                               │
  │── window.open(…, popup) ──►│                               │
  │                            │── redirect ──────────────────►│
  │                            │                               │ (user logs in,
  │                            │                               │  browses tones,
  │                            │                               │  selects one)
  │                            │◄── redirect with ?tone_url ──│
  │                            │                               │
  │◄── localStorage event ────│                               │
  │                            │── waits for "done" signal ──►│
  │                            │                               │
  │── fetch(tone_url) ────────────────────────────────────────►│
  │◄── { tone, models[] } ────────────────────────────────────│
  │                                                            │
  │── show model picker (if multiple models) ──►               │
  │◄── user selects model ──                                   │
  │                                                            │
  │── fetch(model.model_url) ─────────────────────────────────►│
  │◄── .nam file contents ────────────────────────────────────│
  │                                                            │
  │── create NeuralAmpModelBox & load ──►                      │
  │── signal "done" to popup ──►                               │
  │                            │── window.close() ────────────►│
```

## Current State (implemented)

- [x] Step 1: Callback page (`tone3000-callback.html`)
- [x] Step 2: Service logic (`NamTone3000.ts`)
- [x] Step 3: Editor integration (`NeuralAmpDeviceEditor.tsx`)
- [x] Popup window (not tab) — `window.open(url, "tone3000", "width=800,height=900,popup=yes")`
- [ ] Step 4: Model picker dialog (for packs with multiple models)
- [ ] Step 5: Model switching after initial load

## Feedback from Tone 3000 Team

### 1. Popup instead of new tab ✅ Done

> Because the Select Flow opens in a new tab, it's not intuitive that clicking the download button will load the tone natively in openDAW. We recommend a pop-up instead.

Fixed: `window.open()` now uses `"width=800,height=900,popup=yes"` features to open as a popup window.

### 2. Model switching within a pack — TODO

> After downloading a tone pack, there's no way to switch between models within that pack. This matters because some packs contain hundreds of models, and the key identifying information lives in the model name, which can be quite long. The UI needs to accommodate switching between models and displaying these full names.

**Problem:** The current `pickModel()` silently auto-selects the "standard" model. There is no UI for choosing between models, and no way to switch after loading.

**API constraints:** The Select Flow only accepts `app_id` and `redirect_url` — there is no parameter to select individual models. The `tone_url` response embeds all models with pre-signed download URLs. For packs with hundreds of models, the full list comes back in the response.

## Step 4: Model Picker Dialog

After fetching the tone data, if the tone has multiple models, show a **scrollable model picker dialog** before downloading.

Requirements:
- Scrollable list that handles hundreds of entries
- Display full model names (can be long — this is the key identifying information)
- Show model size tag (standard, lite, feather, nano, custom) as a secondary label
- Single-click to select, then confirm — or double-click to select immediately
- Pre-select "standard" model if available

If the tone has only 1 model, skip the dialog and auto-load.

### Implementation

Create `NamModelPicker.tsx` alongside the other NeuralAmp components:

```typescript
// Show a dialog with a scrollable list of models
// Returns the selected model, or undefined if cancelled
showModelPickerDialog(tone: ToneResponse): Promise<Optional<ToneModel>>
```

The dialog should:
- Use the existing `Dialogs.show()` pattern
- Render a list with each entry showing: `model.name` (full, untruncated) + `model.size` badge
- Support keyboard navigation (arrow keys + enter)
- Have a search/filter input at the top for packs with many models

## Step 5: Model Switching After Load

After a tone is loaded, the user needs to switch to a different model from the same pack without going through the Select Flow again.

Approach: **Cache the `ToneResponse`** so the model picker can be re-opened.

- Store the last fetched `ToneResponse` (tone metadata + all model URLs) alongside the browse flow
- Add a way to re-open the model picker using the cached data (e.g., clicking the model name label, or a dedicated "switch model" action)
- When switching, download the new model and replace the current `NeuralAmpModelBox` reference (same create-or-dedup pattern)
- Pre-signed URLs in the cached response may expire — handle fetch failures gracefully (re-trigger Select Flow if needed)

## API Details

### Select Flow Endpoint
```
GET https://www.tone3000.com/api/v1/select
  ?app_id=openDAW
  &redirect_url={callbackUrl}
```

Only two parameters are supported. No `gear`, `platform`, or model-level filtering.

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

### Full API (not currently used)

A paginated `/api/v1/models?tone_id={id}&page=1&page_size=10` endpoint exists in the Full API, but requires authentication (access token via OAuth-like auth flow). The Select Flow's embedded models array with pre-signed URLs is sufficient for now.

## Key Files

| File | Status | Purpose |
|------|--------|---------|
| `packages/app/studio/public/tone3000-callback.html` | ✅ Done | Callback page — receives `tone_url` via localStorage |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/NamTone3000.ts` | ✅ Done (needs update) | Select flow + fetch + model loading |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.tsx` | ✅ Done | Tone 3000 browse button in editor |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.sass` | ✅ Done | Styling |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/Tone3000Dialog.tsx` | ✅ Done | Pre-browse info dialog |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/NamModelPicker.tsx` | TODO | Model picker dialog for multi-model packs |

## Considerations

- **CORS** — The `tone_url` and `model_url` are pre-signed URLs. They should be CORS-friendly for browser fetch.
- **Popup blockers** — `window.open()` is called from a direct user click handler, so popup blockers should not interfere.
- **Pre-signed URL expiry** — Cached `ToneResponse` model URLs may expire. If a download fails after switching models, re-trigger the Select Flow.
- **Model label** — Use `tone.title + " — " + model.name` as the `NeuralAmpModelBox.label`.
- **Offline / local-only** — The existing file-browse flow remains as the primary way to load local `.nam` files.
