# Implement dough-samples to Default openDAW Samples (#255)

**Doability:** ⭐⭐⭐☆☆ (3/5) — no frontend code change needed, but the work is content curation + backend/infra outside this repo, gated on mixed sample licensing
**Type:** content
**Scope:** medium

## What is asked
Integrate the "dough-samples" library (Strudel's default sample set, `github.com/felixroos/dough-samples`) into openDAW's default sample set.

## Current behaviour / relevant code
Default ("standard") samples are not stored in this repo at all — they are served by a remote backend:
- `OpenSampleAPI` (`packages/app/studio/src/opendaw-api/OpenSampleAPI.ts:20-33`) implements the `SampleAPI` interface (`packages/studio/core/src/samples/SampleAPI.ts:5-11`: `all()`, `get(uuid)`, `load(uuid, progress)`, `upload()`, `allowsUpload()`), backed by:
  - `ApiRoot = "https://api.opendaw.studio/samples"` — `list.php` (returns zod-validated `Sample[]`: `uuid`, `name`, `bpm`), `get.php`, `upload.php`.
  - `FileRoot = "https://assets.opendaw.studio/samples"` — raw WAV files fetched by `uuid`, decoded via `WavFile.decodeFloats`.
  - Class comment: "Standard openDAW samples (considered to be non-removable)".
- Local caching/loading goes through `SampleStorage`/`GlobalSampleLoaderManager` (`packages/studio/core/src/samples/`), which is agnostic to where samples come from.
- The equivalent pattern already exists for soundfonts: `OpenSoundfontAPI`/`SoundfontStorage`/`DefaultSoundfontLoader.ts` (`packages/studio/core/src/soundfont/`) — same remote-fetch + local-cache-first + lazy-load shape, useful as a sanity check that this "add a default content pack" pattern has been done before.

Because the manifest and files live on `api.opendaw.studio`/`assets.opendaw.studio` (a backend not in this repository), there is no frontend code path to change to "add" default samples — the studio already lists and plays whatever `list.php` returns.

## Plan
1. **Licensing audit (blocking, do first).** `dough-samples` aggregates multiple sub-collections with different licenses: Salamander Grand Piano (CC-BY 3.0, attribution to Alexander Holm required), VCSL (CC0), Mridangam samples (CC-BY-SA 4.0, attribution to Arthur Carabott / performer Harishankar V Menon), a subset of `tidalcycles/Dirt-Samples`, and samples sourced from `ritchse/tidal-drum-machines`. The Dirt-Samples/tidal-drum-machine subsets are a long-standing live-coding community grab-bag without a clean single license per file — this needs explicit resolution (which sub-collections are safe to redistribute under openDAW's own terms, whether attribution text needs to ship in the app, whether CC-BY-SA "share-alike" collides with anything) before any file is copied.
2. **Pick which sub-collections to include.** Given the mixed licensing, likely start with the unambiguous ones (VCSL = CC0, Salamander piano with attribution) and defer/skip the murkier drum-machine subset, or ship it with an explicit attribution page.
3. **Prepare sample metadata** matching the `Sample` zod schema consumed by `OpenSampleAPI.all()` (`uuid`, `name`, `bpm`) — need per-file UUID assignment, a name, and best-effort BPM tagging (most one-shots have none/0).
4. **Upload to the backend** (`assets.opendaw.studio/samples/<uuid>`) and register in whatever generates `list.php`'s response — this lives outside this repo (server-side, likely a small admin script or manual DB/API insert), so scope this with whoever owns the `api.opendaw.studio` deployment.
5. **No studio frontend changes are required** unless the UX wants sample-pack grouping/browsing by collection (currently `SampleBrowser.tsx`/`SampleView.tsx` list all standard samples flat) — if "dough-samples" should appear as a distinguishable pack/category, that's a small `SampleBrowser`/`Sample` schema addition (e.g. a `tag`/`collection` field), otherwise they just blend into the existing standard list.
6. **Attribution surfacing.** If any included sub-collection requires attribution (Salamander, Mridangam), add credit somewhere reachable (About/Sponsors page, or the manual) — check `packages/app/studio/src/ui/dashboard/Resources.tsx` and `public/sponsors.json`-style patterns for where such credits already live.

## Risks / open questions
- The actual file transfer/registration step is backend infrastructure not present in this repository — this plan can only specify the shape, not execute step 4 from within the codebase.
- Mixed licensing is the real blocker: CC-BY / CC-BY-SA require attribution and (for SA) may impose share-alike constraints on anything built with the samples; Dirt-Samples/tidal-drum-machines provenance is not uniformly documented upstream. Maintainer needs to decide risk tolerance per sub-collection.
- No total sample count or per-file size was confirmed from the upstream README; worth checking actual repo contents (`git clone` or `du`) to size the storage/bandwidth impact on `assets.opendaw.studio` before committing.
- If "default" implies bundling client-side (offline availability) rather than fetched-on-demand, that is a materially different, larger task (new manifest format, embedding assets in the app bundle) — clarify with the reporter whether "default" means "shown in the standard online sample browser" (matches current architecture) or "available offline out of the box."
