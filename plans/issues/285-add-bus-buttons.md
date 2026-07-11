# More buttons to create audio busses (#285)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — creation path is a single well-typed factory call; the work is mostly adding UI affordances in two places.
**Type:** ux
**Scope:** small

## What is asked
Creating an audio bus today is hidden behind: Mixer → a channel's small "output" selector button → a menu item → a name+icon dialog. Add a direct "add bus" button in both the timeline and the mixer panel that creates a bus track immediately, with no naming/icon dialog.

## Current behaviour / relevant code
The only entry point today is `packages/app/studio/src/ui/mixer/ChannelOutputSelector.tsx:52-73`:
```typescript
.addMenuItem(...project.rootBoxAdapter.audioBusses.adapters()
    ...
    label: "New Output Bus...",
    ...
    showNewAudioBusOrAuxDialog("Bus", ({name, icon}) => {
        assert(project.primaryAudioBusBox.isAttached(), "primaryAudioBusBox not attached")
        const audioBusBox = AudioBusFactory.create(project.skeleton, name, icon, AudioUnitType.Bus, Colors.orange)
        adapter.box.output.refer(audioBusBox.input)
    }), IconSymbol.AudioBus))
```
`showNewAudioBusOrAuxDialog` (`packages/app/studio/src/ui/dialogs.tsx:15-40+`) opens a modal with a text input pre-filled with the literal string `"Bus"` and an icon picker; only on "Create" does it call the factory.

The actual creation logic is a plain, side-effect-free factory: `packages/studio/adapters/src/factories/AudioBusFactory.ts`:
```typescript
export const create = (skeleton: ProjectSkeleton, name: string, icon: IconSymbol, type: AudioUnitType, color: Color): AudioBusBox => {
    ...
    const audioBusBox = AudioBusBox.create(boxGraph, uuid, box => {
        box.collection.refer(rootBox.audioBusses)
        box.label.setValue(name)
        box.icon.setValue(IconSymbol.toName(icon))
        box.color.setValue(color.toString())
    })
    const audioUnitBox = AudioUnitFactory.create(skeleton, type, Option.None)
    TrackBox.create(boxGraph, UUID.generate(), box => { ... })
    audioBusBox.output.refer(audioUnitBox.input)
    return audioBusBox
}
```
This can be called directly with a generated name (no dialog) — everything the dialog collects (`name`, `icon`) has a sane default already used as the dialog's placeholder (`"Bus"`, `IconSymbol.AudioBus`).

No existing "add track"-style button was found elsewhere in the timeline (`packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/HeadersArea.tsx`, `packages/app/studio/src/ui/timeline/tracks/footer/TracksFooterHeader.tsx`) — instrument tracks are currently created by dragging a device from the browser panel, not via a dedicated button, so this would be the first "add track" button of this kind in the timeline.

## Plan
1. Add a small helper, e.g. `AudioBusFactory.createDefault(skeleton)` or a call site directly in a new handler, that:
   - generates a non-clashing default name (e.g. `"Bus " + (existingBusCount + 1)`, reading `project.rootBoxAdapter.audioBusses.adapters().length`),
   - calls `AudioBusFactory.create(skeleton, name, IconSymbol.AudioBus, AudioUnitType.Bus, Colors.orange)` inside `project.editing.modify(...)` (the existing dialog-driven call site does not appear to wrap the factory call in `editing.modify` explicitly — verify whether `showNewAudioBusOrAuxDialog`'s `factory` callback is already invoked inside a transaction before reusing the pattern raw).
2. **Mixer button:** add a small icon button near the existing per-channel "output" selector area in `Mixer.tsx`/`ChannelOutputSelector.tsx`, scoped at the mixer level (not per-channel) so it just appends a new bus channel strip, mirroring how `ChannelOutputSelector.tsx`'s menu already lists `project.rootBoxAdapter.audioBusses.adapters()`.
3. **Timeline button:** add an equivalent icon button in the timeline's track-header area (`HeadersArea.tsx` or `TracksFooterHeader.tsx`, whichever renders the "add" affordance most naturally — currently neither has one, so this establishes the pattern) that calls the same default-creation helper.
4. Reuse `IconSymbol.AudioBus` and `Colors.orange` (the constants already used by the dialog path) as the immediate-creation defaults so buses created via button vs. dialog look consistent.
5. Do not remove the existing dialog-based "New Output Bus..." menu item — it still serves users who want to name/color the bus at creation time; the new buttons are an additional fast path.

## Risks / open questions
- Auto-naming collisions: decide the exact naming scheme (`"Bus 1"`, `"Bus 2"`, ...) and whether it should count existing buses or track a monotonic counter to avoid reusing a name after one bus is deleted and another created.
- Confirm whether `AudioBusFactory.create` must run inside `project.editing.modify(...)` for undo/history correctness — the current dialog call site's transaction boundary should be checked directly in `dialogs.tsx`/`ChannelOutputSelector.tsx` before writing the new direct-call path.
- Placement/visual design for both new buttons is undecided; this plan only fixes the "where does it call into" question, not the exact icon/position, which is a UI design call.
