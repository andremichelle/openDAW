# Script Editor Groups

## Feature

Add `// @group <label> <color>` comment directive to script devices. Parameters and samples declared after a `@group` belong to that group until the next `@group` or end of declarations.

## Syntax

```
// @param gain 0.8
// @group Envelope green
// @param attack 0.01 0 1 exp s
// @param decay 0.2 0 2 exp s
// @param sustain 0.7
// @param release 0.5 0 5 exp s
// @group Filter blue
// @param cutoff 1000 20 20000 exp Hz
// @param resonance 0.5
// @sample impulse
```

- Flat, not nested. A new `@group` closes the previous one.
- Color is a key from `Colors` in `@opendaw/studio-enums` (e.g., `green`, `blue`, `orange`).
- `@param` and `@sample` both respect groups.
- Declarations before any `@group` are ungrouped (rendered in a root `div.controls` with no header).
- Groups are ordered by their position in the code. Items within a group keep their declaration order.

## Design Decisions

- **Group header**: Colored background matching the `Colors` key. Black text. Label rotated -90deg (reads bottom-to-top). Fixed width `1.5em`. Stretches over the full height of the group controls.
- **Group container**: A flex row containing the header column and a `div.controls` child (same 3-row grid as today).
- **Code Editor column** stays at the far right, outside any group.
- **No extra separators** — the header column itself separates groups visually.

## Rebuild Strategy

When code changes and groups/parameters/mappings differ from the current state, destroy and rebuild all group containers and controls. No incremental reparenting needed.

## Implementation

### Step 1: Parse `@group` in `ScriptDeclaration.ts`

Add a `GroupDeclaration` type and `parseGroups` function.

```ts
interface GroupDeclaration {
    readonly label: string
    readonly color: string // key from Colors
}
```

`parseGroups(code)` returns an ordered list of sections:

```ts
type DeclarationSection = {
    readonly group: Nullable<GroupDeclaration>
    readonly params: ReadonlyArray<ParamDeclaration>
    readonly samples: ReadonlyArray<SampleDeclaration>
}
```

This replaces the current separate `parseParams` / `parseSamples` / `parseDeclarationOrder` calls in the editor with a single structured parse that preserves grouping.

Add a regex: `const GROUP_LINE = /^\/\/ @group .+$/gm`

Parse logic: iterate all `@group`, `@param`, `@sample` lines in order. Accumulate into sections. First section has `group: null` if params appear before any `@group`.

### Step 2: Update `ScriptDeviceEditor.tsx` — DOM structure

Current structure:
```
div.ScriptDeviceEditor
  div.controls          ← all params/samples here via order
  Column (Code Editor)
```

New structure:
```
div.ScriptDeviceEditor
  div.controls          ← ungrouped params only
  div.group             ← one per @group
    div.group-header    ← colored bg, vertical label
    div.controls        ← params/samples in this group
  Column (Code Editor)
```

The parent `.ScriptDeviceEditor` is already `display: flex; flex-direction: row`. Each `.group` is also a flex row (header + controls).

### Step 3: Update `ScriptDeviceEditor.sass`

```sass
> .group
  display: flex
  flex-direction: row
  align-items: stretch

  > .group-header
    width: 1.5em
    display: flex
    align-items: center
    justify-content: center
    border-radius: 3px 0 0 3px

    > span
      writing-mode: vertical-rl
      transform: rotate(180deg)
      font-size: 0.6em
      font-weight: 600
      text-transform: uppercase
      letter-spacing: 0.05em
      white-space: nowrap
      color: var(--color-black)

  > .controls
    // same rules as root .controls
```

### Step 4: Rebuild logic

In `ScriptDeviceEditor.tsx`, the `pointerHub.catchupAndSubscribe` for params and samples currently appends elements to the single `controls` div.

Change to:
1. On initial load AND on `codeField.subscribe`, parse sections via `parseGroups(code)`.
2. Compare with previous sections (by serialized group labels + param/sample labels). If unchanged, skip.
3. If changed, destroy all existing group containers and the ungrouped controls. Rebuild from sections.
4. For each section, create the group container (or use root controls for ungrouped). For each param/sample in the section, find the matching `WerkstattParameterBox`/`WerkstattSampleBox` from the pointerHub and create the control element.

The existing `set` (UUID set tracking lifecycles) continues to manage individual control teardown. On rebuild, terminate all entries in `set`, clear it, and recreate.

### Step 5: Wire `Colors` lookup

```ts
const resolveGroupColor = (colorName: string): Color => {
    const color = Colors[colorName as keyof typeof Colors]
    return isDefined(color) ? color : Colors.gray
}
```

Use `color.toString()` for the header's `background-color` style.

## Files to modify

| File | Action |
|------|--------|
| `packages/studio/adapters/src/ScriptDeclaration.ts` | Add `GroupDeclaration`, `DeclarationSection`, `parseGroups` |
| `packages/app/studio/src/ui/devices/ScriptDeviceEditor.tsx` | Restructure DOM, rebuild logic |
| `packages/app/studio/src/ui/devices/ScriptDeviceEditor.sass` | Add `.group` and `.group-header` styles |
