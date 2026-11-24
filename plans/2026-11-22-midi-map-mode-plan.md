# MIDI Map Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MIDI map mode with strong highlighting, one-click binding, a MIDI Mapping workspace screen, per-binding
Min/Max, takeover modes, relative encoders and JSON preset export/import.

**Architecture:** Binding data stays in `MIDIControllerBox` (four new fields). `MIDILearning` (studio-core) gets one
MIDI subscription that routes every message through a pure transform module and owns the map-mode state. The app
hooks highlighting into the three `attach*ContextMenu` functions and adds a standalone panel on its own screen.

**Tech Stack:** TypeScript, `@opendaw/lib-box` schema forge, `@opendaw/lib-jsx`, Sass, Vitest (jsdom).

**Revision 2026-11-24:** the maintainer changed the header button, the screen placement, the highlighting, the
device handling and several details after this plan was carried out. See "Revision 2026-11-24" in
`2026-11-22-midi-map-mode-design.md`, it takes precedence over the tasks below.

**Spec:** `plans/2026-11-22-midi-map-mode-design.md`

## Global Constraints

- Follow `CLAUDE.md`: minimal one-line comments, no blank lines inside methods, `Option`/`Nullable`/`isDefined`
  from `@opendaw/lib-std`, `tryCatch` instead of `try/catch`, no `as any`, no `!` assertions, `.hidden` class,
  `MutableObservableOption` instead of `DefaultObservableValue<Nullable<T>>`, `Edit` not `Write` on existing files.
- Never `git commit` without the user's explicit go-ahead for that commit. "Commit" steps below mean: stop, show the
  diff summary, wait.
- Old projects load unchanged: defaults `min 0`, `max 1`, `takeover 0 (Jump)`, `encoding 0 (absolute)`.
- MIDI only; CC only; no Key Map Mode, no notes, no 14-bit CC/NRPN.
- New `PanelType` entries are appended at the end of the enum (values may be stored in workspace state).
- Type-check with `--noEmit`.
- Rebuild changed packages before the app sees them: the app imports `studio-core`/`studio-boxes` from `dist`
  (`npx turbo build --filter=<package>`).

## Review Focus

1. Project saved before this change: missing fields decode to the defaults above (Task 1 test).
2. Moving the already-mapped knob in map mode must not delete/recreate the box on every message (Task 3 test).
3. `min > max` with Pickup and Value Scaling still converges and never leaves `[min(min,max), max(min,max)]`
   (Task 1 tests).
4. Channel filtering: a binding learned on channel 2 ignores the same CC on channel 3; channel `-1` matches all
   (Task 2 test).
5. JSON import of a file with a wrong `version`, missing fields or non-JSON text is rejected without changes
   (Task 5 test).

---

### Task 1: Schema fields + value transform

**Files:**
- Modify: `packages/studio/forge-boxes/src/schema/std/MIDIControllerBox.ts`
- Create: `packages/studio/core/src/midi/MIDIMappingTransform.ts`
- Modify: `packages/studio/core/src/midi/index.ts` (export)
- Test: `packages/studio/core/src/midi/MIDIMappingTransform.test.ts`, `packages/studio/core/src/midi/MIDILearning.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export enum MIDITakeover {Jump = 0, Pickup = 1, Scaling = 2}
  export enum MIDIEncoding {Absolute = 0, TwosComplement = 1, BinaryOffset = 2, SignBit = 3}
  export type MIDIMappingSettings = {min: unitValue, max: unitValue, takeover: MIDITakeover, encoding: MIDIEncoding}
  export class MIDIMappingState {lastController: Nullable<unitValue>; pickedUp: boolean}
  export namespace MIDIMappingTransform {
      decodeRelative(encoding: MIDIEncoding, value: int): int
      apply(settings: MIDIMappingSettings, state: MIDIMappingState, value: int, current: unitValue): Option<unitValue>
  }
  ```
  Box fields: `min` (6, float32, 0.0), `max` (7, float32, 1.0), `takeover` (8, int32, 0), `encoding` (9, int32, 0).

- [ ] **Step 1: Write failing transform tests** (`MIDIMappingTransform.test.ts`; `s = new MIDIMappingState()` per test)
  - Jump full range: `apply({0,1,Jump,Absolute}, s, 127, .3)` → `Some(1)`; value 0 → `Some(0)`.
  - Range: `{min .2, max .6}` value 127 → `.6`, value 0 → `.2`.
  - Inversion: `{min 1, max 0}` value 127 → `0`, value 0 → `1`.
  - Pickup, current `.5`: value 10 → `None`, value 20 → `None`, value 70 → `Some(70/127)`, then value 30 → `Some(30/127)`.
  - Pickup within one step: current `64/127`, first value 64 → `Some(64/127)`.
  - Pickup inverted `{min 1, max 0}`, current `.25`: value 20 → `None`, value 100 (crosses controller `.75`) → `Some(1 - 100/127)`.
  - Scaling, current `.5`: value 32 → `None` (records last), value 64 → `Some(.5 + .5 * (64/127 - 32/127) / (1 - 32/127))`;
    value 127 → `Some(1)`; moving down to 0 ends at `Some(0)`.
  - Scaling inverted stays inside `[0, 1]` for a sweep 0→127→0.
  - `decodeRelative`: TwosComplement 1→1, 127→-1, 65→-63; BinaryOffset 65→1, 63→-1, 64→0; SignBit 1→1, 65→-1.
  - Relative apply, current `.5`, TwosComplement value 1 → `Some(.5 + 1/128)`; current `.999` value 3 → `Some(1)`;
    `{min .2, max .6}` current `.2` value 127 → `Some(.2)` (clamped); takeover is ignored for relative.
- [ ] **Step 2: Run** `cd packages/studio/core && npx vitest run --config vitest.config.ts src/midi/MIDIMappingTransform.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `MIDIMappingTransform.ts`.** Absolute: `controller = value / 127`, `target = min + controller * (max - min)`.
  Pickup: controller position of the current value is `(current - min) / (max - min)`; picked up when the last and the
  new controller lie on different sides of it or `|new - it| <= 1/127`; once picked up it behaves like Jump. The state
  also keeps `lastApplied: Nullable<unitValue>`; if `current` differs from it by more than 1e-6 (changed by mouse or
  automation), `pickedUp` resets to false. Extra test: picked up, then `current` set to `.9` → next value 30 → `None`.
  Scaling in controller space (`p = (current - min)/(max - min)`):
  ```ts
  next = c > last ? p + (1 - p) * (c - last) / (1 - last) : p - p * (last - c) / last
  ```
  then map back with `min + next * (max - min)`. Always update `state.lastController`. Relative: `delta * (1/128) * (max - min)`,
  clamp to `[Math.min(min,max), Math.max(min,max)]`.
- [ ] **Step 4: Run** the transform tests → PASS.
- [ ] **Step 5: Add the four schema fields**, then `npm run build -w @opendaw/studio-forge-boxes` and
  `npx turbo build --filter=@opendaw/studio-boxes`. Check `git diff packages/studio/boxes` only touches `MIDIControllerBox`.
- [ ] **Step 6: Add tests to `MIDILearning.test.ts`:**
  - `"keeps min, max, takeover and encoding after reload"`: set `.2/.6/Pickup/BinaryOffset`, reload, read back equal.
  - `"decodes a mapping saved without the new fields with defaults"`: fields are keyed (`Serializer.readFields` in
    `lib-box/src/serializer.ts` skips nothing it lacks and leaves absent keys at their default). Serialize a box with
    `box.serialize()`, re-write it with `ByteArrayOutput` keeping only keys 1–5 (same layout: magic header, short count,
    per field short key + int length + bytes), `read` it into a fresh box; expect `0/1/Jump/Absolute`.
- [ ] **Step 7: Run** `npx vitest run --config vitest.config.ts src/midi` → PASS.
- [ ] **Step 8: Commit** (after approval): `feat(midi): min/max, takeover and relative encoding per MIDI mapping`.

### Task 2: Route messages through one subscription and the transform

**Files:**
- Modify: `packages/studio/core/src/midi/MIDILearning.ts`
- Test: `packages/studio/core/src/midi/MIDILearning.test.ts`

**Interfaces:**
- Consumes: Task 1 `MIDIMappingTransform`, `MIDIMappingState`, box fields.
- Produces:
  ```ts
  receive(data: Uint8Array, deviceId: string): void   // public, called by the single MidiDevices subscription
  subscribeChanges(observer: Observer<void>): Subscription   // notified on binding add/remove
  controllerBoxes(): ReadonlyArray<MIDIControllerBox>
  ```
  `MIDIConnection` keeps `{box, state: MIDIMappingState, registration: Terminable}`; per-connection MIDI subscriptions go away.
  Private `#bind(field, deviceId: string, channel: int, controlId: int): MIDIControllerBox` used by `learnMIDIControls`.

- [ ] **Step 1: Failing tests:** `"applies min and max to an incoming CC"` (volume mapped CC 7, `min .25 max .75`,
  `receive(control(0, 7, 127), "")` → volume unit value `.75`); `"ignores the same CC on another channel"` (channel 2 binding,
  message on channel 3 → unchanged); `"channel -1 accepts every channel"`; `"notifies changes on add and remove"`.
  Use `MidiData.control(ch, cc, value)`. Unit value via `project.parameterFieldAdapters.get(address).getUnitValue()`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** One `MidiDevices.subscribeMessageEvents` in `followUser` forwards `event.data` + input id to
  `receive`. `receive` matches CC number and channel (`deviceChannel === -1` or equal), calls the transform with
  `adapter.getUnitValue()`, and applies `Some` values through the existing animation-frame throttle. `learnMIDIControls`
  uses `#bind` and then `receive` for the learning message.
- [ ] **Step 4: Run** `src/midi` tests and the whole core suite (`npm test -w @opendaw/studio-core`) → PASS.
- [ ] **Step 5: Commit** (after approval): `refactor(midi): route MIDI mappings through one subscription`.

### Task 3: Map mode state + highlighting

**Files:**
- Modify: `packages/studio/core/src/midi/MIDILearning.ts`
- Test: `packages/studio/core/src/midi/MIDILearning.test.ts`
- Create: `packages/app/studio/src/ui/midi-mapping/MapTargetHighlight.ts`, `MapTargetHighlight.sass`
- Modify: `packages/app/studio/src/ui/menu/automation.ts` (three `attach*` functions)

**Interfaces:**
- Produces (MIDILearning):
  ```ts
  readonly mapMode: DefaultObservableValue<boolean>
  readonly mapTarget: MutableObservableOption<PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>>
  ```
  App: `installMapTarget(midiLearning: MIDILearning, field: PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>, element: Element): Terminable`
  CSS classes: `midi-map-mode` (on `document.body`), `midi-map-assignable`, `midi-map-mapped`, `midi-map-target`.

- [ ] **Step 1: Failing tests:** `"binds the selected target to the next CC in map mode"` (mapMode true, target = volume,
  `receive(control(0, 21, 64))` → connection, `controlId` 21); `"moving the mapped knob again keeps the same box"`
  (second CC 21 → same box UUID); `"another CC re-binds the target"` (CC 22 → one box, `controlId` 22);
  `"does not bind outside map mode"`; `"leaving map mode clears the target"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `receive` before routing (bind only for CC messages; replace
  the target's existing box in the same `editing.modify`). **Step 4: Run** → PASS.
- [ ] **Step 5: Implement `installMapTarget`.** Toggles the classes from `mapMode`, `mapTarget` (compare `address`) and
  `subscribeChanges` (`hasMidiConnection`). Capture-phase `pointerdown` via `Events.subscribe(..., {capture: true})`:
  in map mode `preventDefault()`, `stopImmediatePropagation()`, `mapTarget.wrap(field)`. One module-level
  subscription toggles `midi-map-mode` on `document.body`.
  In `automation.ts` each `attach*` returns `Terminable.many(ContextMenu.subscribe(...), installMapTarget(...))`.
- [ ] **Step 6: Styles.** Outside map mode nothing changes. In map mode: assignable = 2 px outline + tint in a cool
  color; mapped = stronger orange outline + tint; target = 3 px outline + slow pulse. Colors from existing tokens,
  checked in the dark theme.
- [ ] **Step 7:** `npx turbo build --filter=@opendaw/studio-core`, `npx tsc --noEmit -p packages/app/studio`. Browser check
  in Task 4 (the toggle lives there).
- [ ] **Step 8: Commit** (after approval): `feat(midi): map mode with highlighted assignable controls`.

### Task 4: MIDI Mapping panel + screen

**Files:**
- Create: `packages/app/studio/src/ui/midi-mapping/MIDIMappingPanel.tsx`, `MIDIMappingPanel.sass`
- Modify: `ui/workspace/PanelType.ts` (append `MIDIMapping`), `ui/workspace/PanelFactory.tsx`,
  `ui/workspace/PanelContent.tsx`, `ui/workspace/Default.ts` (screen `"midi-mapping"` after `"modulation"`)
- Modify: `packages/studio/adapters/src/ParameterFieldAdapters.ts` only if Task 5 needs enumeration (see there)

**Interfaces:**
- Consumes: `controllerBoxes()`, `subscribeChanges`, `mapMode`, box fields, `ParameterOwner.nameOf / audioUnitOf`,
  `parameterFieldAdapters.opt(address)`.
- Produces: `MIDIMappingPanel({lifecycle, service}: {lifecycle: Lifecycle, service: StudioService}): HTMLElement`.

- [ ] **Step 1: Screen + panel registration** following `PanelType.Analysis` (factory case, content entry) and the layout
  of `"modulation"` (Browser | vertical [MIDI Mapping panel `notMinimizable`, DevicesPanel]). Icon: an existing `IconSymbol`.
- [ ] **Step 2: Panel header:** map mode `Checkbox` bound to `midiLearning.mapMode`, search input, Export, Import,
  Delete selected (Export/Import wired in Task 5, disabled until then).
- [ ] **Step 3: Rows** re-rendered on `subscribeChanges` (pattern of `TargetList`): Port/Ch (`deviceId` input name via
  `MidiDevices.inputDevices()`, else "Any", plus channel+1), CC, Track/Device (`audioUnitOf` label / `nameOf`; click →
  `userEditingManager.audioUnit.edit(unit.box.editing)`), Parameter name, Min, Max (`NumberInput` editing the unit value,
  shown via the target's `stringMapping`), Takeover and Encoding (`MenuButton`), row selection checkbox.
  Header click sorts (asc/desc), search filters case-insensitively over the text columns; both view state only.
- [ ] **Step 4:** `npx tsc --noEmit -p packages/app/studio`; dev server; verify with `MidiDevices.softwareMIDIInput`
  (or the on-screen keyboard's software input) sending CCs: toggle map mode → controls highlighted; click knob → target;
  send CC → row appears, knob follows; Min/Max/Takeover edit takes effect; locate works; delete selected removes rows;
  reload project → rows persist. Screenshot as proof.
- [ ] **Step 5: Commit** (after approval): `feat(midi): MIDI Mapping screen with mapping list`.

### Task 5: JSON export/import

**Files:**
- Create: `packages/studio/core/src/midi/MIDIMappingPreset.ts`, test `MIDIMappingPreset.test.ts`
- Modify: `packages/studio/adapters/src/ParameterFieldAdapters.ts` (add `adapters(): ReadonlyArray<AutomatableParameterFieldAdapter>`)
- Modify: `MIDIMappingPanel.tsx` (wire Export/Import)

**Interfaces:**
- Produces:
  ```ts
  export type MIDIMappingPresetEntry = {address: string, unit: string, owner: string, parameter: string,
      deviceId: string, channel: int, controlId: int, min: number, max: number, takeover: int, encoding: int}
  export type MIDIMappingPreset = {version: 1, mappings: ReadonlyArray<MIDIMappingPresetEntry>}
  export type MIDIMappingImportResult = {imported: int, replaced: int, skipped: int}
  export namespace MIDIMappingPreset {
      create(project: Project): MIDIMappingPreset
      parse(text: string): Option<MIDIMappingPreset>
      apply(project: Project, preset: MIDIMappingPreset): MIDIMappingImportResult
  }
  ```
  `address` is `Address.toString()`, resolved with `Address.decode`. `unit` = audio unit label, `owner` =
  `ParameterOwner.nameOf`, `parameter` = adapter `name`.

- [ ] **Step 1: Failing tests:** `"exports a mapping with address and names"`; `"imports into the same project by address"`
  (delete box, apply → imported 1); `"imports into another project by names"` (fresh `ProjectSkeleton.empty` → different
  UUIDs, same names → imported 1 on primary volume); `"skips an ambiguous name match"` (two audio units with the same
  label → skipped 1); `"replaces an existing binding on the same parameter"` (replaced 1, still one box);
  `"rejects malformed input"`: `parse("{")`, `parse('{"version":2,"mappings":[]}')`, entry missing `controlId` → `None`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`tryCatch` around `JSON.parse`, explicit field checks, no `as any`;
  name match iterates `parameterFieldAdapters.adapters()`). **Step 4: Run** → PASS.
- [ ] **Step 5: Wire UI:** Export → `Files.save(encoded JSON, {suggestedName: "midi-mappings.json", types: [json]})`;
  Import → `Files.open` → `parse` → `apply` → `RuntimeNotifier.info` with "Imported N, replaced N, skipped N" (or an error
  for invalid files). Browser check: export, delete all, import, rows restored.
- [ ] **Step 6:** Full suites: `npm test -w @opendaw/studio-core`, `npm test -w @opendaw/studio-adapters`, app `tsc --noEmit`.
- [ ] **Step 7: Commit** (after approval): `feat(midi): export and import MIDI mappings as JSON`.
