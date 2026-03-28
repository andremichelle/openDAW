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
- [ ] Step 4: Store entire pack in OPFS (`tone3000/{tone.id}/`)
- [ ] Step 5: Add `packId` field to NeuralAmpModelBox schema
- [ ] Step 6: Model dropdown in editor UI (replaces static label)
- [ ] Step 7: Handle missing pack (dropdown shows "No pack available")

## Feedback from Tone 3000 Team

### 1. Popup instead of new tab ✅ Done

> Because the Select Flow opens in a new tab, it's not intuitive that clicking the download button will load the tone natively in openDAW. We recommend a pop-up instead.

Fixed: `window.open()` now uses `"width=800,height=900,popup=yes"` features to open as a popup window.

### 2. Model switching within a pack — TODO

> After downloading a tone pack, there's no way to switch between models within that pack. This matters because some packs contain hundreds of models, and the key identifying information lives in the model name, which can be quite long. The UI needs to accommodate switching between models and displaying these full names.

**Problem:** The current `pickModel()` silently auto-selects the "standard" model. There is no UI for choosing between models, and no way to switch after loading.

**API constraints:** The Select Flow only accepts `app_id` and `redirect_url` — there is no parameter to select individual models. The `tone_url` response embeds all models with pre-signed download URLs. For packs with hundreds of models, the full list comes back in the response.

## Step 4: Store entire pack in OPFS

When a user selects a tone from Tone 3000, download **all models** in the pack and store them in OPFS. This eliminates pre-signed URL expiry issues and enables offline model switching.

### OPFS layout

```
tone3000/{tone.id}/
  pack.json          ← pack metadata (title, model list with ids, names + sizes)
  models/
    {model.id}.nam   ← raw model JSON, keyed by numeric model id
```

`pack.json` structure (derived from `ToneResponse`, but without `model_url` since those expire):

```typescript
interface PackMeta {
    toneId: number
    title: string
    updatedAt: string   // from Tone.updated_at — used for cache invalidation
    models: ReadonlyArray<{ id: number, name: string, size: string }>
}
```

The `id` field (from `Model.id` in the API) is used as the OPFS filename — it's unique within a pack and avoids issues with special characters in model names.

### Download flow

1. After `fetchTone(toneUrl)` returns the `ToneResponse`, check if `tone3000/{tone.id}/pack.json` exists in OPFS
2. If cached: compare `tone.updated_at` from the fresh response against `pack.json.updatedAt`. If they match → skip download, go straight to model loading. If they differ → download only the missing/new models, remove stale ones, update `pack.json`
3. If not cached: download all models in the pack (parallel fetch with concurrency limit), store each in OPFS, then write `pack.json`
4. Show download progress — packs can be up to 80MB. Open question: progress in the Tone 3000 popup or in the editor itself (TBD)
5. Support cancellation — if cancelled, clean up partially written pack folder
6. After storing, load the default "standard" model (same as today)

### Access pattern

```typescript
// Reading a model from a cached pack
const json = await Workers.Opfs.read(`tone3000/${toneId}/models/${modelId}.nam`)
const modelText = new TextDecoder().decode(json)
```

## Step 5: Add `packId` field to NeuralAmpModelBox

Store the Tone 3000 pack ID on the model box so the UI can look up the pack in OPFS after project reload.

### Schema change

Add field `3: packId` (StringField) to the `NeuralAmpModelBox` schema:

```typescript
// packages/studio/forge-boxes/src/schema/std/NeuralAmpModelBox.ts
export const NeuralAmpModelBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NeuralAmpModelBox",
        fields: {
            1: {type: "string", name: "label"},
            2: {type: "string", name: "model"},
            3: {type: "string", name: "pack-id"}  // ← new, becomes `packId` in generated class
        }
    },
    pointerRules: {accepts: [Pointers.NeuralAmpModel], mandatory: true},
    resource: "preserved"
}
```

- Store `tone.id.toString()` in this field when creating a model box from Tone 3000
- Leave empty for locally imported `.nam` files (no pack association)
- Regenerate the box class after schema change

### Usage

When the UI sees a non-empty `packId`, it knows:
- The model came from Tone 3000
- The full pack lives at `tone3000/{packId}/` in OPFS
- The dropdown should be enabled for model switching

## Step 6: Model dropdown in editor UI

Re-layout the editor to accommodate pack info and model selection. The device keeps its overall height — the spectrum analyser loses one row to make room.

### Layout change

Current grid: `grid-template-rows: 5em 2em 3.5em` (3 rows, 2 gaps)
```
Row 1: spectrum analyser          (5em)
Row 2: [tone3000] [local] [model name ............] [info]
Row 3: [input gain] [mix] [output gain] [mono]
```

New grid: `grid-template-rows: 3em 2em 2em 3.5em` (4 rows, 3 gaps)
```
Row 1: spectrum analyser (reduced height)          (3em)
Row 2: [tone3000] [local]              [pack name →]   ← browse buttons + pack label (right-aligned)
Row 3: [◄] [model dropdown ............] [►] [info]    ← prev/next arrows + model dropdown + info
Row 4: [input gain] [mix] [output gain] [mono]         ← unchanged
```

### Spectrum grid

Add a light grid to the spectrum canvas, matching the compressor curve style:
- Color: `"hsla(200, 40%, 70%, 0.12)"` (same as the existing canvas outline)
- Line width: `1.0 / devicePixelRatio` (thin, crisp)
- Drawn before the spectrum path in `SpectrumRenderer.ts`

### Row details

- Row 2: browse buttons stay, model name span is replaced with the **pack title** (right-aligned, pushed to edge). Shows "No pack" if no pack is loaded
- Row 3: new row with prev/next arrows, model dropdown (shows current model name, opens grouped list), and the info button
- Row 4: knobs stay in their position

### Behavior

- The dropdown is always present, regardless of whether the model came from Tone 3000 or local import
- On model load (or `packId` change): eagerly read `pack.json` from OPFS into memory. This is small (just id/name/size per model, no actual model data)
- On click (synchronous): populate dropdown from the in-memory model list
  - If list is available: show all model names + size badges, highlight the currently loaded model
  - If `packId` is empty or pack was not found in OPFS: show a single non-selectable entry "No pack available"
- On selection: load the chosen `.nam` from OPFS (async), create/dedup `NeuralAmpModelBox`, update the device's model pointer

### Model switching flow

```
Model loads / packId changes → read pack.json from OPFS into memory (async, eager)

User clicks dropdown          → show in-memory model list (synchronous)
                              → user picks a model
                              → read model .nam from OPFS (async)
                              → compute SHA256 UUID
                              → find or create NeuralAmpModelBox (set packId + label)
                              → update adapter.box.model pointer
                              → clean up old model box if orphaned
```

### UI details

- Long model names are truncated with ellipsis (tooltip shows full name)
- Models grouped by size category (standard, lite, feather, nano, custom) as section headers in the dropdown. Each category lists its models underneath. Categories with no models are omitted
- Simple scrollable dropdown, no filter/search (filters deferred to a future iteration)
- Two arrow buttons (prev/next) alongside the dropdown for quick sequential navigation. The order must match the dropdown: models sorted by category (standard → lite → feather → nano → custom), then by name within each category
- Typical packs: 1–20 models, sometimes 60, rare outliers at 300+
- Size categories are known from the API's `Model.size` field and stored in `pack.json`

## Step 7: Handle missing pack

If the user opens a project referencing a `packId` but the pack is missing from OPFS (cleared cache, different machine), the dropdown shows "No pack available". Re-triggering the Tone 3000 Select Flow for the same tone will re-download the pack and restore the dropdown.

## API Details

### Select Flow Endpoint
```
GET https://www.tone3000.com/api/v1/select
  ?app_id=openDAW
  &redirect_url={callbackUrl}
  &gear={gear}        (optional filter)
  &platform=nam        (filter to NAM only — device cannot handle IRs or other formats)
```

### Select Flow Response (fetched from `tone_url`)
```typescript
type Gear = "amp" | "full-rig" | "pedal" | "outboard" | "ir"
type Platform = "nam" | "ir" | "aida-x" | "aa-snapshot" | "proteus"
type Size = "standard" | "lite" | "feather" | "nano" | "custom"
type License = "t3k" | "cc-by" | "cc-by-sa" | "cc-by-nc" | "cc-by-nc-sa" | "cc-by-nd" | "cc-by-nc-nd" | "cco"

interface EmbeddedUser {
  id: number
  username: string
  avatar_url: string | null
  url: string
}

interface Make { id: number, name: string }
interface Tag { id: number, name: string }

interface Tone {
  id: number
  user_id: number
  user: EmbeddedUser
  created_at: string
  updated_at: string
  title: string
  description: string | null
  gear: Gear
  images: string[] | null
  is_public: boolean | null
  links: string[] | null
  platform: Platform
  license: License
  sizes: Size[]
  makes: Make[]
  tags: Tag[]
  models_count: number
  downloads_count: number
  favorites_count: number
  url: string
}

interface Model {
  id: number
  created_at: string
  updated_at: string
  user_id: number
  model_url: string  // pre-signed, no auth needed
  name: string
  size: Size
  tone_id: number
}

// tone_url returns:
type SelectResponse = Tone & { models: Model[] }
```

### Full API (not currently used)

A paginated `/api/v1/models?tone_id={id}&page=1&page_size=10` endpoint exists in the Full API, but requires authentication. The Select Flow's embedded models array with pre-signed URLs is sufficient for now. Rate limit: 100 requests/minute.

## Key Files

| File | Status | Purpose |
|------|--------|---------|
| `packages/app/studio/public/tone3000-callback.html` | ✅ Done | Callback page — receives `tone_url` via localStorage |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/NamTone3000.ts` | ✅ Done (needs update) | Select flow + fetch + OPFS pack storage + model loading |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.tsx` | ✅ Done (needs update) | Tone 3000 browse button + model dropdown |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmpDeviceEditor.sass` | ✅ Done (needs update) | Styling for dropdown |
| `packages/app/studio/src/ui/devices/audio-effects/NeuralAmp/Tone3000Dialog.tsx` | ✅ Done | Pre-browse info dialog |
| `packages/studio/forge-boxes/src/schema/std/NeuralAmpModelBox.ts` | TODO | Add `packId` field (Step 5) |
| `packages/studio/boxes/src/NeuralAmpModelBox.ts` | TODO | Regenerate after schema change (Step 5) |

## Considerations

- **CORS** — The `tone_url` and `model_url` are pre-signed URLs. They should be CORS-friendly for browser fetch.
- **Popup blockers** — `window.open()` is called from a direct user click handler, so popup blockers should not interfere.
- **Pre-signed URL expiry** — No longer an issue for model switching. All models are downloaded to OPFS upfront. Expiry only matters if the initial download fails mid-way (retry with new Select Flow).
- **Model label** — Use `tone.title + " — " + model.name` as the `NeuralAmpModelBox.label`.
- **Offline / local-only** — The existing file-browse flow remains as the primary way to load local `.nam` files.
- **OPFS storage size** — Packs with many models will consume significant OPFS space. Consider showing pack size before download and/or offering a "delete cached pack" action.
- **Pack deduplication** — If the same pack is selected again via Select Flow, detect it by `tone.id` and skip re-download.
- **Concurrent downloads** — Use a concurrency limit (e.g., 4-6 parallel fetches) when downloading pack models to avoid overwhelming the browser or the API.
