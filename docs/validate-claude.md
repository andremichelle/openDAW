# Validate Claude

A growing log of mistakes Claude has made working in this repo, kept so future
sessions can avoid repeating them. Each entry describes the wrong move, why it
was wrong, and what to do instead.

---

## 1. Defensive `tryCatch` around APIs that never reject

**Where it happened:** `packages/studio/core/src/presets/PresetStorage.ts`,
`rebuildIndex`.

**The mistake:** wrapped `Workers.Opfs.list(FOLDER)` in
`await Promises.tryCatch(...)` and added a `if (list.status === "rejected")`
branch as a fallback for the "folder missing" case.

```ts
// wrong
const list = await Promises.tryCatch(Workers.Opfs.list(FOLDER))
if (list.status === "rejected") {
    await writeAndCache([])
    return []
}
const entries = list.value
```

**Why it was wrong:** `OpfsWorker.list` already guards internally —
`#resolveFolder` is wrapped in `tryCatch` and the missing-folder case returns
`Arrays.empty()`. The protocol contract is "list always resolves; missing folder
yields `[]`". My defensive wrapper added a dead `rejected` branch and obscured
the real intent.

**What to do instead:** read the implementation (or the protocol docs) before
adding speculative error handling. If a function "feels" like it might reject,
trace it once. If it can't, await it directly.

```ts
// right
const entries = await Workers.Opfs.list(FOLDER)
```

**Generalisable lesson:** error handling has a cost (extra branches, dead code,
noise) and should reflect actual failure modes — not assumed ones. CLAUDE.md
already warns: *"Don't add error handling, fallbacks, or validation for
scenarios that can't happen."* Apply it.

---

## 2. Structural casting through `unknown` to reach a field the declared type doesn't have

**Where it happened:**
- `LibraryBrowser.tsx` — reading `.label` off an `IndexedBox`.
- `PresetStorage.ts` (`inspectRackBinary`) — reading `.label` off a `Box`.
- `PresetDecoder.ts` (`insertEffectChain`) — reading `.index` off a `Box`.

**The mistake:** used `as unknown as { label?: StringField }` (and similar) to
launder the type and access a field the declared type doesn't expose.

```ts
// wrong
const label = (box as unknown as {label?: {getValue(): string}}).label
const value = isDefined(label) ? label.getValue() : ""
```

**Why it was wrong:** this is a type-system bypass — "I know better than the
checker, let me read whatever field I want." It has the same flavour as
`as any`, just dressed up with an extra `unknown` hop. CLAUDE.md explicitly
forbids `as any` and says *"Use the actual type from its source — never
create ad-hoc structural types."* The double-cast obeys the letter of "no
`as any`" while violating the spirit.

Problems that follow:
- If the underlying box genuinely doesn't have `label`, there's no check at
  runtime until the code blows up (`.getValue()` on `undefined`).
- Refactors that rename or remove fields don't propagate — the cast hides
  the reference.
- Every reader has to audit the cast and reason about whether it's actually
  safe, because nothing else does.

**What to do instead:** there's always a proper way in this repo. **Use the
adapter layer or a real type guard.** Do NOT reach for reflective field-name
lookups (`box.fields().find(f => f.fieldName === "label")`) — that's the same
problem with an extra hop. It's still "guess the field at runtime and hope
it's the right shape".

- **Adapters** for project-resident boxes:
  `project.boxAdapters.adapterFor(box, Devices.isAny)` returns a typed
  `DeviceBoxAdapter` with a properly-declared `labelField`. All the
  properties are typed. No cast, no reflection.

- **Box type guards** for standalone boxes (e.g. freshly deserialised from a
  preset binary, not attached to the project graph). The repo ships
  `DeviceBoxUtils.isInstrumentDeviceBox(box)`, `isEffectDeviceBox(box)`,
  `isDeviceBox(box)` — these narrow via `box.tags` and typecheck the
  resulting shape (which includes `label: StringField`, `enabled`, etc.).
  `IndexedBox.isIndexedBox(box)` does the same for `index: Int32Field`.

  ```ts
  // right
  const labeled = DeviceBoxUtils.isInstrumentDeviceBox(inputBox)
      ? inputBox.label.getValue()
      : ""
  ```

  The guard returns `box is InstrumentDeviceBox` — TypeScript then knows
  `inputBox.label` exists, is a `StringField`, and can be called with
  `.getValue()`. Zero casts.

**Generalisable lesson:** whenever you're about to reach for `as X`, pause
and find the type guard, adapter, or reflective API that would give you the
same information safely. `as unknown as T` is not a loophole — it's the same
mistake in a wig. And `fields().find(f => f.fieldName === "X")` is the
reflective version of that same mistake — skip both. The repo already has
the guards; use them.

---

## 3. Resolving drag sources via ambient state instead of snapshotting the payload

**Where it happened:** `AnyDragData.DragDevice` — both the instrument variant
(`{type: "instrument", device: null}`, source resolved via
`project.userEditingManager.audioUnit.get()`) and the effect variant
(`start_indices: ReadonlyArray<int>`, resolved the same way).

**The mistake:** the drag payload carried no identifier for the source box.
Drop handlers reached into the currently-edited audio unit at drop time and
pulled out "whichever instrument is there now" (or the effect at
`start_indices[i]` in whatever chain is currently active).

```ts
// wrong: payload names no source; drop re-reads ambient state
{type: "instrument", device: null}
// then:
resolveDraggedInstrumentKey(_dragData) {
    const editing = this.project.userEditingManager.audioUnit.get()
    // …pull the instrument out of the currently-edited audio unit
}
```

**Why it was wrong:** native drag events span a human pointer gesture. Between
`dragstart` and `drop`, *anything* can touch the project — another user in a
collaborative session, a scheduled callback, a notification's side effect, a
keyboard shortcut the user fires mid-drag. If `userEditingManager.audioUnit`
changes during that window, the drop resolves a completely different box
than the one the user actually grabbed. Silent data corruption; the save
writes the wrong instrument.

**What to do instead:** snapshot identity at `dragstart`. Put the source
UUID (or UUIDs, for multi-selection) into the drag payload. Drop handlers
look the box up by UUID via `project.boxGraph.findBox(uuid)`; if it's gone,
the drop becomes a no-op.

```ts
// right: payload names the source; drop is immune to ambient state
{type: "instrument", origin: "panel", uuid: UUID.String}
// or for effects: a list of effect box UUIDs, not indices
```

**Generalisable lesson:** any handler that fires *later than* the event that
initiated it (drag/drop, modal dialog, scheduled callback) must not rely on
ambient project state captured via getters like
`userEditingManager.audioUnit.get()`. Snapshot the inputs into the payload,
resolve by identity at consumption time, and tolerate "source disappeared"
gracefully. Ambient lookups are fine for *synchronous* UI code (`onclick`
handlers that run inside the same turn as the event), but the moment you
span a user gesture or an `await`, the world can shift.

---
