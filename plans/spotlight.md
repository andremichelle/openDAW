# Spotlight

A command line for the studio, like macOS Spotlight. A global shortcut opens it, typing starts immediately, Enter runs
the highlighted entry. Long term it creates, finds, edits, moves and removes anything in the project. The first
iteration only creates devices, presets and script devices.

## Status

Old, unused code in `packages/app/studio/src/ui/spotlight/`:

- `Spotlight.tsx`: `Spotlight.install(surface, service)` opens a draggable box in `surface.flyout` on Shift+Enter or
  Cmd+F (capture-phase keydown, bypasses the shortcut manager). Nobody calls `install`.
- `SpotlightDataSupplier.ts`: a flat list of `{name, exec}` matched by `startsWith`, every result gets the Play icon.
- `StudioService.spotlightDataSupplier` registers three placeholder actions with `EmptyExec`.

Both files are rebuilt to the current code style and quality (lib-std null checks, no `let`, no `!`, Layers instead
of a raw flyout append if that fits, sass following the dialog house style). Only the idea of the view (input, result
list, focus-out closes) carries over. The supplier and the `StudioService` placeholder wiring are replaced.

## Model

Everything the Spotlight shows is an **entry**: a verb, a subject, a label, an icon, an enabled state, a run function.

```ts
type SpotlightVerb = "create" | "go" | "edit" | "move" | "remove"

type SpotlightEntry = {
    readonly verb: SpotlightVerb
    readonly label: string          // "Create Delay", "Create Apparat with Wavetable script"
    readonly keywords: ReadonlyArray<string> // matched against the query: device name, preset name, script name, tags
    readonly icon: IconSymbol
    readonly enabled: boolean       // false = shown greyed out, Enter does nothing
    readonly hint: string           // right-aligned detail: "Audio Effect", "Preset · Stock", "Script · Community"
    readonly run: () => Promise<void>
}
```

Entries come from **providers**. A provider is asked for its entries when the Spotlight opens (it reads the current
project state, e.g. the edit-mode audio unit) and may update them while it is open (the cloud preset index arriving).

```ts
interface SpotlightProvider {
    entries(context: SpotlightContext): ObservableValue<ReadonlyArray<SpotlightEntry>>
}
```

New capabilities (go to an instance, remove, move) are new providers. The view and matching stay the same.

### Verbs

A query is `[verb] subject`. The verb picks which entries are searched, the subject is matched against them. Each verb
searches only its own entries, so adding a verb never crowds the results of another one.

| Verb   | Word     | Symbol | Example                      | Iteration |
|--------|----------|--------|------------------------------|-----------|
| create | `create` | `+`    | `+vapo`, `create delay`      | 1         |
| remove | `remove` | `-`    | `-delay`                     | later     |
| open   | `open`   | `/`    | `/bundle`, `op stems`        | 0 (projects, bundles, imports) |
| goto   | `goto`   | `@`    | `@mixer`, `goto preferences`  | 0 (places), later instances |
| move   | `move`   | `>`    | `>vapo`                      | later     |
| edit   | `edit`   | `=`    | `=bpm`                       | later     |

- **Symbol**: a single character at the start, no space needed: `+vapo`. The fastest form.
- **Word**: the full verb followed by a space. Any unique prefix of the word counts (`cr vapo`), Tab completes it to the
  full word.
- **No verb**: no verb is preselected, the query searches the entries of every verb. `vapo` alone works.
- A typed verb is shown left of the input (icon and word). Without one nothing is shown.
- Symbols and words are one table in code (`SpotlightVerbs`), the help line under an empty input lists them.
- The symbols are checked on a German and a US keyboard before they are fixed (`@` and `>` need modifiers on both).

### App states

The entries depend on the state of the app, each state is a strategy of providers:

- **Always**, with or without a project: `goto` entries for app places (dashboard, scripting, preferences, storage,
  manuals, manifesto, privacy, imprint). Workspace screens (arrangement, mixer, modulation, ...) are listed too and
  greyed out without a project.
- **Always**: studio `create` entries, `Create New Project` and `Create New Live Room` (the dashboard buttons).
- **No project**: device, preset and script entries are listed too. Running one starts a new project first, then
  creates the device in it. Effects stay greyed out (no unit in edit mode). Opening a bundle or project and the imports
  are `open` entries, available with or without a project.
- **Project loaded**: the create entries, later instances, project search and the other verbs.

## Iteration 0: design

The full look and feel of iteration 1 without the create logic, so the design can be tuned first.

- The rebuilt view: input, verb indicator, result list, help line, dragging, remembered position, all keyboard and
  mouse handling (see View).
- `open-spotlight` registered in `GlobalShortcuts` (Shift+Enter, Cmd+F), `StudioService` installs it.
- Verb parsing (symbols, words, prefixes, Tab completion, default verb) and matching/ranking, with their unit tests.
- Real entries with real labels, icons, hints and greyed states: instruments, effects, presets, community scripts.
  Greyed states follow the edit-mode unit, so they can be seen changing.
- Running an entry does nothing but close the Spotlight and show a toast with the entry's label.
- The old `SpotlightDataSupplier` and the placeholder actions in `StudioService` are removed.

Done when André has looked at it in the browser and the design is settled.

## Iteration 1: create

Implemented 2026-10-22 in `SpotlightCreate.ts`, browser check pending. Script compiler configs moved to
`ui/devices/ScriptCompilers.ts`, shared with the three script device editors.

### Instruments

One entry per `InstrumentFactories.Named` device: "Create Vaporisateur", "Create Playfield", ...

- Runs `project.api.createInstrument(factory, {index})` inside `editing.modify`.
- Insert position: after the edit-mode audio unit if it is an instrument unit, otherwise the factory's default (end
  of the instruments, before buses and output). `index` is the edit-mode unit's index + 1.
- The new unit becomes the edit-mode unit (createInstrument already does this).

### Effects

One entry per `EffectFactories.MergedNamed` device (audio and MIDI effects): "Create Delay", "Create Arpeggio", ...

- Appends to the end of the matching chain of the edit-mode audio unit, the same rules as
  `PresetService.createEffect` (`DeviceHost.takesEffect`, `DeviceHost.chainFieldOf`).
- Greyed out when no audio unit is in edit mode, or when it does not take that kind (a MIDI effect on an audio track).
  The hint says why: "Select an audio unit first", "Takes no MIDI effects".
- `PresetService.createEffect` notifies instead of greying out. The Spotlight checks the same conditions up front, so
  the shared check moves into a function both use.

### Presets

One entry per preset from `PresetService.presets()` (user + stock): "Create Vaporisateur · Bright Pad".

- Instrument presets create a new unit with the preset, placed like instruments above.
  `PresetApplication.createNewAudioUnitFromInstrument` only places BEFORE an anchor today, it gains an index variant.
- Rack presets (`audio-unit`) create a new unit, same placement.
- Effect and effect-chain presets append to the edit-mode unit, greyed out under the same rules as effects.
- Running reuses `PresetService.activatePreset`, extended by the insert position.
- Stock presets come from the cloud index, `PresetService.cloudReady` updates the list while open.
- Presets match by their own name only. The device name narrows (`vapo bright`) but never matches alone, so `vapo`
  lists the device, not its hundreds of presets.
- A device with presets or scripts shows their count and an arrow. → (or a click on the arrow) enters the device and
  lists all of them, the input then filters them. ←, Backspace on an empty input or Escape leave it.

### Script devices

One entry per script for Apparat, Werkstatt and Spielwerk: "Create Apparat with Wavetable script".

- Source: the community index (`CommunityAPI`). Every script has exactly one target (`apparat`, `werkstatt`,
  `spielwerk`), which picks the device. `project` scripts and the locally saved scripts (`ScriptStorage`, project
  scripts of the code editor page) are not device scripts and stay out.
- Runs: create the device (Apparat as an instrument, Werkstatt/Spielwerk as effects with the rules above), load the
  script source, then compile it into the box with the device's `ScriptCompiler`, the same call the editor uses for a
  fresh box. The device editor then finds stored code and only loads it.
- The compiler config lives in each device editor today. It moves next to the factories so the Spotlight can compile
  without an editor open.
- Loading the source is async (network). The entry runs it with the progress notifier the presets use.

### Matching and ranking

- Case-insensitive, matched per word: every query word must be a prefix of some keyword word ("vapo", "fade in",
  "wave").
- Rank: exact word match, then prefix of the first word, then prefix of a later word. Within a rank: devices, then
  presets (user before stock), then scripts. Enabled before disabled.
- Show at most ~12 entries, scroll for more.

### View

- Shortcuts: keep Shift+Enter and Cmd+F, registered in `GlobalShortcuts` as `open-spotlight` (two entries), so they
  appear in the shortcut manager and stop firing inside text fields (the old capture listener stole Shift+Enter from
  the chat overlay).
- Opens where it was last dragged (first time centred at a third of the height), with an empty input, focused.
- Up/Down move the highlight, Enter runs, Escape or focus-out closes. Mouse hover highlights, click runs.
- Disabled entries render greyed with their reason as the hint.
- Each entry shows the device icon from its factory (`defaultIcon`).

## Later iterations

1. **Go to instances**: "vapo" also lists every Vaporisateur in the project. Running scrolls the timeline to its
   track, or the mixer to its channel strip, depending on the screen, and puts the unit in edit mode.
2. **Adjust the insert position after create**: after "Create XYZ", keep the Spotlight open in a placement mode where
   Up/Down move the new unit, Enter confirms. Needs a design.
3. **Project search**: "fadein" finds devices, regions, samples, markers and anything else by name and moves the view
   there.
4. **Remove, move, edit** verbs, with prefixes decided by then.
5. WebCLAP plugins from the catalogue, soundfonts and samples as create entries.

## Decided

1. Device scripts come only from the community index, one target device per script.
2. Effect and effect-chain presets without a fitting edit-mode unit are greyed out with the reason, like effects.
3. The box stays draggable and keeps its position between openings for the session, as the old code does.

## Testing

- Unit tests for matching and ranking (query → ordered labels), including multi-word and disabled ordering.
- Unit tests for insert position: no edit-mode unit, instrument in edit mode, bus in edit mode.
- Browser check by André: open, type, create each kind, greyed effect entries, script devices compile and play.
