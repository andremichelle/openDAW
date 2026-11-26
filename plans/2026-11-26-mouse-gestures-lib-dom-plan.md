# PR 1 — `MouseGesture` and its definitions in lib-dom

## Context

The timeline and piano roll hardcode their mouse modifiers (`WheelScroll.ts`, `RegionsArea.tsx`, `PitchEditor.tsx`,
`AudioUnitsTimeline.tsx`). The goal is rebindable mouse gestures (wheel zoom, wheel pan, middle-drag pan, Ctrl +
middle-drag zoom), built the same way as the keyboard shortcuts (factory → working copy → storage → editor).
This first PR only adds the data model to `@opendaw/lib-dom`, with unit tests. Nothing in the app uses it yet, so
behaviour is unchanged. PR 2 (dispatcher + call-site migration), PR 3 (storage + preferences UI) and PR 4 (new
actions + presets) are planned later.

Branch: `mouse-gestures-lib-dom` from `next-release`.

## Files

| File | Change |
|---|---|
| `packages/lib/dom/src/mouse-gesture.ts` | new: `MouseGesture` class + merged namespace for its types |
| `packages/lib/dom/src/mouse-gesture-definitions.ts` | new: `MouseGestureDefinition(s)` + `MouseGestureValidator` |
| `packages/lib/dom/src/mouse-gesture.test.ts` | new: tests for the class |
| `packages/lib/dom/src/mouse-gesture-definitions.test.ts` | new: tests for definitions and conflicts |
| `packages/lib/dom/src/index.ts` | export both new modules next to `shortcut-definitions` / `shortcut-manager` |

## 1. `mouse-gesture.ts`

Mirror `Shortcut` in `packages/lib/dom/src/shortcut-manager.ts:114-262` (private constructor, `#` fields, `Notifier`).

```ts
export class MouseGesture {
    static of(input: MouseGesture.Input, modifiers?: {ctrl?: boolean, shift?: boolean, alt?: boolean}): MouseGesture
    static fromJSON(value: JSONValue): Option<MouseGesture>
    static fromWheel(event: MouseGesture.Modifiers): MouseGesture
    static fromPointer(event: MouseGesture.Modifiers & Pick<PointerEvent, "button">): Option<MouseGesture>
    get input / ctrl / shift / alt
    equals(other: MouseGesture): boolean
    matches(input: MouseGesture.Input, event: MouseGesture.Modifiers): boolean
    format(): ReadonlyArray<string>
    overrideWith(gesture: MouseGesture): void
    subscribe(observer: Observer<void>): Subscription
    toJSON(): JSONValue
    copy(): MouseGesture
    toString(): string
}

export namespace MouseGesture {
    export type Input = "wheel" | "middle-drag"
    export type Modifiers = Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">
}
```

- Ctrl goes through `Keyboard.isControlKey` (`src/keyboard.ts:4`), so it means Cmd on macOS, like `Shortcut`.
- Separate `fromWheel` / `fromPointer` instead of one `fromEvent`: no casts needed to tell the event types apart.
  `fromPointer` returns `Option.None` for any button other than 1 (middle).
- The `Pick<…>` parameter types (same approach as `Keyboard.isControlKey`) let the tests pass plain objects. Node has
  no `WheelEvent` or `PointerEvent` (see `src/events.test.ts:4`).
- `fromJSON` follows `Shortcut.fromJSON`: reject anything that is not an object, an `input` outside `Input`, and
  modifiers that are not booleans. Checks use `isAbsent` / `isDefined` from lib-std.
- `format()` follows `Shortcut.format()`: modifier symbols on macOS (⇧ ⌥ ⌘), `Shift`/`Alt`/`Ctrl` joined by `+`
  elsewhere, then `Wheel` or `Middle Drag`.
- `overrideWith` notifies only when something changed, exactly like `Shortcut.overrideWith`.
- Not in this PR: which gestures are reserved (for example, plain wheel scrolls vertically). That is app policy and
  belongs to PR 2/3.

## 2. `mouse-gesture-definitions.ts`

Mirror `src/shortcut-definitions.ts`:

```ts
export type MouseGestureDefinition = {gesture: MouseGesture, description: string}
export type MouseGestureDefinitions = Record<string, MouseGestureDefinition>

export namespace MouseGestureDefinitions {
    export const copy: <T extends MouseGestureDefinitions>(defs: T) => T
    export const copyInto: (source, target) => void
    export const toJSON: (defs) => JSONValue
    export const fromJSON: (defs, values: JSONValue) => void
}

export namespace MouseGestureValidator {
    export const conflicts: (defs) => ReadonlyArray<[string, string]>
    export const validate: <T extends MouseGestureDefinitions>(defs: T) => T
}
```

- `conflicts` returns every pair of keys with equal gestures. `validate` calls it and alerts each pair like
  `ShortcutValidator.validate`. Having a pure `conflicts` makes the tests independent of `alert`.
- `fromJSON` skips unknown keys and malformed values, like `ShortcutDefinitions.fromJSON`.
- `copy` needs one generic cast to `T`, like `ShortcutDefinitions.copy`. Avoid it if possible (for example
  `Object.fromEntries` mapped over `Objects.entries` with a typed accumulator). If it can't be avoided, keep the
  existing pattern and note it in the PR.

## 3. Style checks (AGENTS.md)

One-line comments only, no blank lines inside function bodies, `Array<T>`/`ReadonlyArray<T>`, `Option` for fallible
returns, `isDefined`/`isAbsent` instead of `=== null`, no `as` casts (see above), descriptive lambda parameter names,
exported helpers inside namespaces. `mouse-gesture.ts` keeps one definition: the class plus its merged namespace.

## 4. Tests (vitest, node environment)

`mouse-gesture.test.ts`
- `of` defaults to no modifiers; getters reflect the arguments.
- `toJSON` → `fromJSON` round trip for both inputs and every modifier combination.
- `fromJSON` rejects `null`, arrays, strings, an unknown `input` and non-boolean modifiers.
- `matches`: exact modifiers match; an extra or missing modifier fails; the wrong input fails.
- macOS: `vi.spyOn(Browser, "isMacOS").mockReturnValue(true)` → `metaKey` counts as Ctrl and `ctrlKey` does not.
- `fromWheel` keeps the modifiers; `fromPointer` gives Some for button 1 and None for 0 and 2.
- `equals`, `copy` (independent instance); `overrideWith` notifies once on a change and not at all for an equal
  gesture.
- `format` on both platforms.

`mouse-gesture-definitions.test.ts`
- `copy` creates independent gestures; `copyInto` overrides the target in place.
- `toJSON` → `fromJSON` round trip; unknown keys and malformed entries are ignored and the rest still applies.
- `conflicts` finds an equal pair and ignores the same input with different modifiers or the same modifiers with a
  different input. `validate` returns its argument and calls `alert` once per conflict (`vi.stubGlobal("alert", …)`).

## Verification

```
npx tsc --noEmit -p packages/lib/dom
npx turbo run test --filter=@opendaw/lib-dom
npx eslint packages/lib/dom/src/mouse-gesture*.ts
```

Then merge `next-release` into the branch, check that the diff touches only the files listed above, and open the PR
against `next-release`.
