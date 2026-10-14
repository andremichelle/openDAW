# Undo History: Steps, Tail and Gestures

## Problem

UI state such as the edited audio unit, the edited region or the selection is recorded with `modify(..., false)`.
It stays in `#pending` and folds FORWARD into the next marked step. Consequences:

1. Switch audio unit, turn a knob, undo: the knob AND the switch are reverted, the view jumps back.
2. Switch audio unit, undo: `undo()` seals the pending switch as a step of its own, so undo only moves the view.
3. A gesture start calls `mark()` (`RelativeUnitValueDragging.tsx:75`), which turns leftover UI state into a phantom
   step of its own.
4. `UserEditing.clear()` is a marked `modify`, so closing an editor is a full undo step.
5. Workarounds pile up: `DevicesClipboardHandler.ts:252` and `ModulatorsClipboardHandler.ts:77` call `mark()` before
   copying only to keep the editing pointer out of the following paste.
6. `revertPending()` on gesture cancel (`MarkerDragging.ts:36`, `SlotEditor.tsx:98`) reverts EVERYTHING pending,
   including a view switch or selection that happened before the drag.
7. Discrete content edits are recorded unmarked and silently join whatever comes next: `EditWrapper.forValue`
   (17 editors), Duplicate AudioUnit (`StudioShortcutManager.ts:155`, `TrackHeaderMenu.ts:89`), capture device
   selection (`capture.ts:41,55`), tap tempo, MIDI learn, WebCLAP parameter writes, recording.

The root cause is that one boolean (`mark`) and one method (`mark()`) carry three different meanings: "this is UI
state", "this is part of a gesture still being built" and "seal whatever is pending". `mark()` cannot know whether
the pending changes are leftover UI state (belongs to the previous step) or the gesture itself (its own step).

## Model

History is a list of closed steps. Every change belongs to exactly one of three places.

**Step**
A unit of undo. Created atomically by `modify`, or over time by an open `EditingStep` (gesture, recording, import).

**Tail**
Changes that belong to the LAST step but arrived after it closed: selection, edited audio unit, edited region,
edited modular system. Recorded so they can be reverted, never a step of their own.

**Untracked**
Raw graph transactions outside the editing (migrations, WebCLAP parameter mirror, sync). Unchanged by this plan.

Rules:

1. A new step (atomic or committed `EditingStep`) that contains changes closes the tail into the last step, truncates
   the redo stack and is appended. At history index 0 there is no last step, the tail joins the baseline (not
   undoable).
2. `undo()` reverts the tail, then reverts the last step. Result: the step and the UI state that followed it are
   undone together. Nothing else.
3. `redo()` reverts the tail, then replays the next step. The tail was made against a state the redo step was not
   recorded on, so it is discarded. Redo therefore stays available after clicking around following an undo, which
   today is blocked (`canRedo` is false while anything is pending).
4. While an `EditingStep` is open, `amend` and `modify` from anywhere join that open step. Steps nest: a step begun
   while another is open becomes a child, only the outermost commit reaches the history. The outermost open step owns
   ONE chronological log. Every change from the step, its children, `amend` and `modify` is appended to that log in
   the order it happens. A child keeps no buffer of its own, only the indices of its entries in the log, so its
   commit just drops that index list and nothing is ever moved. History order therefore always equals temporal
   order, both between steps and inside a step, so a step can never reference a box created by a later step, and
   undo restores every field to its true previous value.
5. `canUndo()` and `canRedo()` are false while a step is open.
6. Cancel reverts only the step's own changes (its log entries, in reverse) and removes them from the log. The tail
   and any enclosing step are untouched. If the enclosing step wrote one of the same fields after the child began,
   reverting the child would restore a stale value over the newer one. In that case cancel logs a warning and still
   reverts the child entries (rare: Escape during a drag while recording touches the same field).
7. An empty step (click without drag) commits nothing and does not touch the tail or the redo stack.
8. The saved position is the history index plus a tail version, so saving neither seals the tail nor truncates redo.

Walkthrough of the reported case: change knob on A (step N), switch to B (tail of N), turn knob on B (opens step,
commits as N+1, tail closed into N). Undo reverts N+1 only, the view stays on B. Undo again reverts N and the switch,
the view returns to A, which is where step N happened.

## Situations

Each box is one undo step. One UNDO removes the right-most box.

### 1. Switch to another unit, turn a knob, undo (the reported case)

```
 you do:      turn knob on A        switch to B        turn knob on B        UNDO

 TODAY
              +--------------+                         +----------------+
              | knob A       |                         | switch to B    |
              +--------------+                         | knob B         |
                                                       +----------------+
                                                         UNDO removes both:
                                                         knob B is reset AND the view jumps back to A

 NEW
              +--------------+                         +----------------+
              | knob A       |                         | knob B         |
              | switch to B  | <-- the switch joins    +----------------+
              +--------------+     the box before        UNDO removes knob B only,
                                                         the view stays on B
```

### 2. Switch to another unit, undo

```
 you do:      turn knob on A        switch to B        UNDO

 TODAY        +--------------+      +--------------+
              | knob A       |      | switch to B  |    UNDO only jumps back to A,
              +--------------+      +--------------+    the song does not change

 NEW          +--------------+
              | knob A       |                         UNDO resets knob A and shows A,
              | switch to B  |                         where it happened
              +--------------+
```

The same applies to closing an editor and to switching before a copy and paste (today worked around with
`mark()` in the clipboard handlers).

### 3. Select, start a drag, press Escape

```
 you do:      select region         drag region ...      ESC

 TODAY        not yet in a box:  [ selection | drag ]
                                   \___________________/
                                     ESC reverts all of it, the selection is lost

 NEW          +--------------+      + - - - - - - - +
              | ...          |      : drag (open)   :    ESC reverts only the open drag,
              | selection    |      + - - - - - - - +    the selection stays
              +--------------+
```

### 4. Two unrelated edits, undo

```
 you do:      oversampling to 2x    delete region      UNDO

 TODAY        +---------------------------------+
              | oversampling 2x                 |      UNDO brings the region back
              | delete region                   |      AND resets the oversampling
              +---------------------------------+

 NEW          +-----------------+   +-----------------+
              | oversampling 2x |   | delete region   |  UNDO brings the region back only
              +-----------------+   +-----------------+
```

Same for duplicate unit, capture device, tap tempo, MIDI learn and WebCLAP parameters.

### 5. Undo, click something, redo

```
 you do:      UNDO                  click a region     REDO

              done                         can be redone
 TODAY        [1] [2] [3] [4]              [5]
              [1] [2] [3] [4] (click)      [5]  <-- REDO disabled, [5] is lost with the next edit

 NEW          [1] [2] [3] [4]              [5]
              [1] [2] [3] [4] + click      [5]  <-- REDO drops the click and brings [5] back
```

### 6. Record a take, turn a knob while recording, undo

```
 you do:      RECORD .............. turn knob .............. STOP          UNDO

 TODAY        +---------------+ +--------+ +---------------+
              | take, part 1  | | knob   | | take, part 2  |               UNDO removes part 2 only
              +---------------+ +--------+ +---------------+

 NEW          +--------------------------------------------+
              | take with the recorded knob automation     |               UNDO removes the whole take
              +--------------------------------------------+
```

### 7. A step inside a step writes the same value (why one shared log)

```
 time  -------------------------------------------------------------->
              knob sets f from 1 to 2      recording sets f from 2 to 3

 SEPARATE LISTS, joined at the end
              [ recording: 2 -> 3 ][ knob: 1 -> 2 ]
              UNDO walks right to left:  f = 1, then f = 2     ends at 2, WRONG

 ONE LOG, in the order it happened
              [ knob: 1 -> 2 ][ recording: 2 -> 3 ]
              UNDO walks right to left:  f = 2, then f = 1     ends at 1, correct
```

## API

```ts
export interface Editing {
    modify<R>(modifier: SyncProvider<Maybe<R>>): Option<R> // atomic step
    amend<R>(modifier: SyncProvider<Maybe<R>>): Option<R> // joins the open step, else the tail of the last step
    begin(): EditingStep // step built over time
    undo(): boolean
    redo(): boolean
    canUndo(): boolean
    canRedo(): boolean
    markSaved(): void
    hasUnsavedChanges(): boolean
    hasNoChanges(): boolean
    subscribe(observer: Observer<void>): Subscription
}

export interface EditingStep extends Terminable { // terminate() = commit() when open
    modify<R>(modifier: SyncProvider<Maybe<R>>): Option<R>
    commit(): void
    cancel(): void
    get isOpen(): boolean
}
```

Removed: `modify(modifier, mark)`, `mark()`, `append()`, `revertPending()`, `BoxEditing.beginModification()`.
`BoxEditing.clear()` and `disable()` stay.

Nested calls keep today's behaviour: any `modify`, `amend` or `step.modify` inside a running modifier executes
directly and is captured by the enclosing recorder.

## Call-site migration

Every history call site outside `lib/box` (AST scan, tests excluded). About 340 plain `modify(fn)` calls are already
atomic steps and stay unchanged.

### Tail (`amend`)

| Site | Today | New |
|---|---|---|
| `VertexSelection.ts:80,100` select/deselect | `modify(, false)` | `amend` |
| `UserEditing.ts:30` edit | `modify(, false)` | `amend` |
| `UserEditing.ts` clear | marked `modify` (phantom step) | `amend` |
| `ScriptCompiler.ts:219` initial code of a new device | `append` | `amend` |

### Gestures (`begin` / `commit` / `cancel`)

The pattern `mark()` at start, `modify(, false)` per move, `mark()` or `revertPending()` at end becomes
`const step = editing.begin()`, `step.modify` per move, `step.commit()` or `step.cancel()`.

| Site | Notes |
|---|---|
| `RelativeUnitValueDragging.tsx:75-81` drag, `:92-98` wheel | wheel commits in the existing debounce |
| `VolumeSlider.tsx:172-183`, `:200-215` drag, `:227-233` wheel | same |
| `FrequencySplitGraph.tsx:107-131` | |
| `MarkerDragging.ts:34-37` (Nano) | `revertPending` becomes `cancel` (fixes 6) |
| `SlotEditor.tsx:90-99` (Playfield) | `revertPending` becomes `cancel` |
| `EnvelopeEditor.tsx:109-345` (Neon) | |
| `DxEnvelopeEditor.tsx:119-127`, `TubularScalingDisplay.tsx:88-101` | |
| `BaseFrequencyControl.tsx:63-66`, `TempoControl.tsx:66-69` | cancel writes become `step.cancel()` |
| `ModularView.tsx:81-94`, `LoopAreaEditor.tsx:82-95` | |
| `MarkerTrackBody.tsx:83-92` | cancel today is a MARKED modify (creates a step), becomes `cancel` |
| `StepsDisplay.tsx:88-97`, `MacroEditor.tsx:46` | MacroEditor click today never seals |
| `AudioEditorCanvas.tsx:124-157`, `TransientMarkerEditing.ts:100-102`, `WarpMarkerEditing.ts:166-168` | |
| `RegionsArea.tsx:319-346` slope drag | |
| `NoteCreateModifier.ts:62-110` | step opens at creation, cancel replaces the delete |
| `ValueEditor.tsx:145` + `ValueMoveModifier.ts:189-261` | `chainPending` flag removed: the double-click create opens the step and hands it to the move modifier |
| `TapButton.tsx:42`, `TapTempo.tsx:166` | step per tap sequence, commit on reset or idle |
| `MIDILearning.ts:129` | step per controller burst, commit on idle (same debounce as wheel) |
| `WclapParameters.ts:73` | CLAP gesture begin(1)/end(2) map to `begin`/`commit`, value(0) outside a gesture is an atomic `modify` |
| `TubularAudition.tsx:171-198` batch preset export | step that is CANCELLED at the end: the temporary preset loads leave no trace and the restore code goes away |

### Long-running steps

| Site | New |
|---|---|
| `Recording.ts` | one step from start to stop, all of `RecordAudio`, `RecordMidi`, `RecordAutomation` write through it (marked and unmarked alike). Everything the user does during the take (knob moves that record automation, selection, view) joins it, so one undo removes the whole take. `RecordAudio.ts:153` `mark()` on save goes away. |
| `Project.ts:482` restartRecording | `cancel()` of the running recording step, then a fresh one |
| `MidiImport.ts:141` | `begin`, generate through `step.modify` per chunk, `commit` or `cancel`. Removes the `BoxEditing` cast. |
| `AudioUnitsClipboardHandler.ts:157` output paste | `begin`, `step.modify(clear)`, `step.modify(paste)`, `commit` |

### Discrete edits that are unmarked today (become `modify`)

| Site | Notes |
|---|---|
| `EditWrapper.ts:11` (17 editors: device options, piano mode, track headers) | own step per change |
| `StudioShortcutManager.ts:155`, `TrackHeaderMenu.ts:89` Duplicate AudioUnit | copy and the editing pointer in one `modify` |
| `capture.ts:41,55` capture device and channel | |
| `WclapStates.ts:12` plugin state blob | `modify`, see open question 2 |

### Removed workarounds

| Site | Reason |
|---|---|
| `DevicesClipboardHandler.ts:252`, `ModulatorsClipboardHandler.ts:77` `mark()` before copy | tail closes into the previous step by rule 1 |
| `WclapDeviceEditor.tsx:207`, `WclapWindows.tsx:118`, `VolumeSlider.tsx:209`, `RelativeUnitValueDragging.tsx:55` `modify` followed by `mark()` | `modify` is already a step |
| `ProjectProfile.ts:67,89` `mark()` before save | rule 8 |
| `AuxSendGroup.tsx:45` `modify(, true)` | parameter gone |

### Unchanged

`ProjectImpl.ts:258` (scripting `Context.edit` runs raw transactions on its own graph), YSync (raw transactions,
never in local history), `WclapParameters.reconcile` (untracked by design), undo/redo buttons and shortcuts.

## Implementation phases

Each phase ends with `tsc --noEmit` and the test suites green.

1. **Core.** `BoxEditing` gets the step buffer, tail, nesting and saved position. The new methods are added next to
   the old ones. `editing.test.ts` gets the new suite first (red): every rule above, the reported case,
   `revertPending` scope, redo after clicking, nested steps with interleaved parent and child writes on the same field
   (undo must restore the original value), `amend` while a step is open lands in log order, cancel inside a nested
   step, cancel of a child whose field the parent overwrote (warning), empty step, saved position
   with tail, undo/redo disabled while open, failure rollback in undo/redo with a tail present.
2. **Adapters and core.** `UserEditing`, `VertexSelection`, `ScriptCompiler`, recording, MIDI learn, WebCLAP,
   clipboard handlers, `ProjectProfile`, `Project.restartRecording`.
3. **Studio app.** Gestures, `EditWrapper`, menus, `MidiImport`, `TubularAudition`.
4. **Removal.** Delete `mark`, `append`, `revertPending`, `beginModification` and the `mark` parameter. The compiler
   then proves no caller is left. Old tests that assert the forward-fold behaviour (`editing.test.ts`, #208/#306 cases)
   are rewritten to the new expectations, each change listed in the commit message.
5. **Browser check.** Switch unit then knob then undo, region editor open then note edit then undo, drag cancel with
   Escape after a selection, recording with knob moves then one undo, MIDI import then undo, paste device inside a
   composite branch then undo.
6. **SDK notes.** Migration table for consumers (below) in the release notes.

## SDK migration (breaking)

| Old | New |
|---|---|
| `modify(fn)` | unchanged |
| `modify(fn, false)` for UI state | `amend(fn)` |
| `mark()` + `modify(fn, false)` + `mark()` | `begin()`, `step.modify(fn)`, `step.commit()` |
| `revertPending()` | `step.cancel()` |
| `append(fn)` | `amend(fn)`, or a step when two transactions must form one undo entry |
| `beginModification()` / `approve()` / `revert()` | `begin()` / `commit()` / `cancel()` |

`ProjectEnv.createEditing` implementers must implement `amend` and `begin`.

## Open questions

1. **Undo during recording.** Rule 5 disables undo while the recording step is open. Alternative: undo stops the
   recording and undoes the take.
2. **WebCLAP state echo.** If the plugin reports its state again after our undo restored it, and the bytes differ
   from what we wrote, `modify` creates a new step and kills redo. Needs a check with a real plugin before choosing
   `modify`.
3. **Deprecation shim.** Hard break (recommended, the compiler finds every site) or one release where `mark` and
   `modify(fn, false)` still exist and log a deprecation warning.
