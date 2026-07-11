# Automation track automatic naming (#212)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — concrete gap, all needed accessors already exist, work is contained to two `ProjectApi` factories plus label rendering.
**Type:** feature
**Scope:** small-medium

## What is asked
Automation clips/regions currently default to the literal label "Automation," with the actual automated parameter's name shown only small and dim. The parameter name should drive the visible label (prepended/appended to any custom name), and that portion should not be user-editable.

## Current behaviour / relevant code
Two related but distinct places show "automation" text today:

1. **Track header** (the audio-unit track list on the left), `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx:27-41`: already resolves and shows both the device name and the bound parameter/control name via `trackBoxAdapter.catchupAndSubscribePath` (`packages/studio/adapters/src/timeline/TrackBoxAdapter.ts:50-71`, returns `[deviceName, targetName]`). Both `nameLabel` and `controlLabel` render as `<h5>` at the same small font-size (`TrackHeader.sass:39-44`, `font-size: 0.625em` for both) — this already surfaces the parameter name, just not prominently.

2. **Clip/region label** (what's actually rendered large, on the clip/region block itself, in the arranger and clip launcher) hardcodes "Automation" as the default and never reflects the bound parameter:
   - `packages/studio/core/src/project/ProjectApi.ts:338-352` — `createValueClip`: `box.label.setValue(name ?? "Automation")`.
   - `packages/studio/core/src/project/ProjectApi.ts:398-410` — `createTrackRegion`'s `TrackType.Value` case: same `"Automation"` default.
   - Rendered as-is in `packages/app/studio/src/ui/timeline/tracks/audio-unit/clips/Clip.tsx:56,76` (`label.textContent = adapter.label...`) and the region-equivalent renderer — whatever the user set (or the "Automation" default) is shown verbatim, full-size, as the primary identifier.

The parameter name is available at clip/region-creation time the same way `ParameterValueEditing.ts:44-49` already resolves it: `trackBoxAdapter.target` (a `PointerField<Pointers.Automation>`) → target address → `project.parameterFieldAdapters.get(address)` → `.name`.

## Plan
1. In `ProjectApi.createValueClip` and the `TrackType.Value` branch of `createTrackRegion`, resolve the bound parameter's name via `trackBox.target.targetVertex` → address → `parameterFieldAdapters.get(address).name`, and use it as the label instead of the literal `"Automation"` fallback (keep `"Automation"` only as the ultimate fallback when the track has no bound target yet).
2. Decide the "non-modifiable, before/after a custom name" composition: e.g. store the user's custom text separately from the derived parameter name, and compose the display string at render time (`Clip.tsx`, region label renderer) as `` `${paramName}${customName ? " – " + customName : ""}` ``, rather than overwriting `box.label` — this avoids re-deriving the name if the user later reassigns automation to a different parameter, and matches "non-modifiable" (the parameter-name portion is always derived, never hand-edited).
3. Update the rename interaction (double-click label to rename, e.g. `ClipContextMenu.ts:38-45`, `RegionContextMenu.ts:75-80`) to only edit the custom-name portion, leaving the derived parameter-name portion intact.
4. Subscribe clip/region label rendering to the bound parameter's name changing (e.g. if the user later reassigns the track's target), so the derived portion stays in sync — reuse `TrackBoxAdapter.catchupAndSubscribePath`'s existing subscription pattern (`TrackBoxAdapter.ts:50-71`) as the model.
5. Consider whether the track-header display (`TrackHeader.tsx`) should also change emphasis (larger/brighter parameter name vs. device name) as part of the same pass, since the issue's "small/dark" complaint may partly describe that view too — confirm with the reporter which surface (track header vs. clip/region label) they mean before finalizing visual styling changes.

## Risks / open questions
- Needs UX confirmation on the exact display composition ("before/after") and separator/styling for combining the derived parameter name with a custom label.
- Clips/regions can be created before a track has a bound target (`trackBoxAdapter.target` empty) — must keep a sane fallback ("Automation" or "Unassigned", matching `ValueEditorHeader.tsx:32`'s existing "Unassigned" wording) for that case.
- If the label is later meant to update reactively when the user reassigns the automation target mid-project, this needs a live subscription in the clip/region rendering path, not just a one-time value computed at creation.
