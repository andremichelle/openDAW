# Automation Region Editor - Specify Automation Region Unit and Resolution (#38)

**Doability:** ⭐⭐☆☆☆ (2/5) — large design surface; several sub-asks already exist for free, but the persisted per-region config is a new schema feature.
**Type:** feature
**Scope:** large

## What is asked
Per-automation-region control over:
- Resolution: divide the region into N fixed divisions (grid for drawing).
- On/off (boolean) mode.
- Unit: raw automation value, interpolated percentage, or a fixed external unit (e.g. MIDI CC 0-127).

## Current behaviour / relevant code
Some of this already falls out of the existing architecture, because the value editor derives its behaviour from the bound parameter's `ValueMapping`, not from a per-region setting:
- `ParameterValueEditing` (`packages/app/studio/src/ui/timeline/editors/value/ParameterValueEditing.ts`) implements `ValueContext`:
  - `quantize(value)` (line 92-100) round-trips through the parameter's own `ValueMapping` (`mapping.x(mapping.y(value))`), so automating a parameter whose mapping is already e.g. `ValueMapping.linearInteger(0, 127)` naturally snaps drawn values to integer steps — this is the existing mechanism `StringMapping`/`ValueMapping` pairs use across the codebase.
  - `floating` (line 88-90) reads `assignment.adapter.valueMapping.floating()` and controls whether new segments default to `Interpolation.Linear` or `Interpolation.None` (step/on-off) — see `ValueEditor.tsx:131`. So boolean parameters already render/edit as on/off steps automatically.
- What does **not** exist: a way to force this behaviour independent of the underlying parameter — e.g. viewing/editing a continuous filter-cutoff automation region as if it were a coarse N-step or on/off signal, or displaying raw automation values (0-127-style) instead of the parameter's natural interpolated percentage, scoped to one region rather than derived from the parameter.
- No per-region UI surface exists for this today: `packages/app/studio/src/ui/timeline/editors/value/ValueEditorHeader.tsx` only shows a static help block and the assigned parameter's name; there's no resolution/unit control.
- No box schema field exists for "region resolution" or "region unit override" — `ValueRegionBox`/`ValueClipBox` (`packages/studio/boxes/src/ValueRegionBox.ts`, `ValueClipBox.ts`) would need new persisted fields if this is meant to be saved with the project (implied by "useful for CC values with fixed resolution," i.e. a stable editing mode, not a transient view toggle).

## Plan
1. **Clarify scope with the maintainer first** (see risks) — this determines whether it's a persisted per-region property (schema change) or a session-only view preference (no schema change, much smaller).
2. If persisted: add fields to `ValueRegionBox`/`ValueClipBox` (e.g. `resolution: Int32Field`, `displayUnit: StringField` or an enum field) via the standard box-schema + migration process (`packages/studio/boxes/src/*`), then surface them on the corresponding adapters (`ValueRegionBoxAdapter`, `ValueClipBoxAdapter`).
3. Add a resolution/unit control to `ValueEditorHeader.tsx` (dropdown(s) alongside the existing help text and parameter name).
4. Implement grid-division rendering: extend `ValuePainter.ts`'s grid drawing (currently `renderTimeGrid` for the time axis, `ValuePainter.ts:49`) with an analogous value-axis divider renderer driven by the region's `resolution` setting.
5. Implement quantization: extend `ValueContext.quantize` (or add a region-level override consulted before the parameter-mapping round-trip) so drawn/dragged values snap to the region's N divisions or boolean on/off, independent of the underlying parameter's native mapping.
6. Implement unit display override: when "raw"/"MIDI CC" is selected, bypass `assignment.adapter.stringMapping`/`valueMapping` for display purposes (tooltips, `ValueTooltip.ts`, and the input field `installValueInput` in `ValueEditor.tsx:299-310`) and show the region's chosen unit instead — the underlying stored event values remain 0-1 either way (no engine/WASM implications, this is purely an authoring aid).

## Risks / open questions
- Needs a maintainer decision: persisted region property vs. transient editor preference. This single decision changes scope from "UI-only, ~small" to "schema migration across TS (and any WASM mirroring of region/clip box layout)."
- If persisted, must audit whether `crates/` mirrors `ValueRegionBox`/`ValueClipBox` layout (WASM frozen-contract fields, `project_wasm_frozen_contracts.md`) — new fields would need Rust-side additions in lockstep even though they don't affect DSP, since the WASM engine reads the same box graph.
- Overlaps conceptually with #154 (automation generation) in the grid/resolution UI — consider designing the value-axis grid renderer once for both.
