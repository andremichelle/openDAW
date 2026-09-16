# Studio Tour

A guided, non-modal walkthrough of the studio UI that runs after a project is opened or created.
One bright card moves through the studio, points at the group it explains, and switches screens as
it goes. Brief text only, an overview, not a manual.

## User-facing behaviour

- **Offer.** When a project becomes current (`ProjectProfileService` goes `Some`, both open and new)
  and the default screen is mounted, a small dialog asks "Take a quick tour of the studio?" with
  buttons `Not now` / `Start tour` and a checkbox `Never show this again`.
  - `Start tour` starts the tour.
  - `Not now` just closes the dialog. It is asked again on the next project open.
  - Checkbox checked (either button) writes the preference and the offer never returns.
  - Not offered for engine restarts (profile unchanged), not offered while another dialog is open.
- **Preference.** `visibility["offer-studio-tour"]` (default `true`), label
  "Offer the studio tour when a project opens". Rendered automatically by `PreferencePanel`.
- **Manual start.** No menu entry. To see the tour again, turn the preference back on and open a
  project from the dashboard.
- **The card.** One headline, one short float text, a close button and a `Next` button that
  shows its shortcut (`→`). The last card's button reads `Finish`.
  - Advance: `Next` button or `ArrowRight` / `Enter`.
  - Back: `ArrowLeft`.
  - Dismiss at any point: `Escape` or the close button.
  - The last card's advance finishes the tour.
  - The studio stays fully interactive underneath (no backdrop, no pointer blocking).
- **Notch.** When a card has a target, it sits next to the target with a notch pointing at it.
  Cards without a target (whole-screen cards) are centered, no notch.
- **Screens.** The tour switches screens by itself via `service.switchScreen(key)`. On finish or
  dismiss it returns to `default` and restores what it changed (browser tab, clip visibility).
- **Target ring.** Only the six header steps (`frame: true`) get a thin bright ring. It is a
  separate fixed overlay element, not an outline on the target, so it is never clipped. Panel and
  area targets get no ring, they would only frame empty space.
- **Manuals.** After the last card a small dialog offers to open the manuals in the manuals tab.
  Escape and the close button do not offer it.
- **Abort.** The tour ends itself when the project closes or the profile changes mid-tour.
- **Backdrop.** None for now. A glassy backdrop is a later design pass.

## Card order

Placement is the preferred side, the layout code flips it when there is no room.

### default screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 1 | openDAW Menu | header menu button | below |
| 2 | Manuals | header manuals link | below |
| 3 | MIDI | midi access + capture group | below |
| 4 | Transport | `TransportGroup` | below |
| 5 | Timecodes | `TimeStateDisplay` | below |
| 6 | Screens | header `panel-selector` | below |
| 7 | Presets | browser panel, tab switched to Presets | right |
| 8 | Samples | browser panel, tab switched to Samples | right |
| 9 | Soundfonts | browser panel, tab switched to Soundfonts | right |
| 10 | Clips | clips area of the timeline (clips made visible for this card) | right |
| 11 | Regions | region area of the timeline | above |
| 12 | Devices | Devices panel | centered on panel |

### mixer screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 13 | Mixer | first channel strip | right |
| 14 | Analysis | Analysis panel | centered on panel |

### modulation screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 15 | Modulation | Modulation panel | centered on panel |

### piano screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 16 | Piano Tutorial Mode | none | centered |

### project screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 17 | Project Info | none | centered |

### shadertoy screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 18 | Shadertoy | none | centered |

### tap screen

| # | Headline | Target | Placement |
|---|----------|--------|-----------|
| 19 | Match Tempo | none | centered |

After 19 the tour switches back to `default` and ends.

## Draft copy

Two sentences max. Verbs first, no feature lists.

1. **openDAW Menu**. Create, open, save and export projects here. Preferences and the debug tools live here too.
2. **Manuals**. Opens the manuals in a separate tab whenever you need more than this tour.
3. **MIDI**. Enable MIDI access to play with a keyboard or controller. The capture button learns a controller for the knob you touch next.
4. **Transport**. Play, stop, record and loop. The metronome and count-in sit right next to it.
5. **Timecodes**. Shows where you are in bars and in time. Click a field to type a new position.
6. **Screens**. Switch between the arrangement, mixer, modulation and the special views. Each has a keyboard shortcut.
7. **Presets**. Instruments and effects ready to drop onto the timeline or into a device chain.
8. **Samples**. Your audio files. Drag one onto the timeline to create a track, or onto a sampler.
9. **Soundfonts**. General MIDI style instrument banks. Drag one to the timeline like a preset.
10. **Clips**. Launch loops per track without arranging them. Great for sketching ideas live.
11. **Regions**. The arrangement. Draw, move, loop and edit notes and audio on the tracks.
12. **Devices**. The instrument and effect chain of the selected track. Every knob can be automated or modulated.
13. **Mixer**. Levels, panning, sends and routing for every track and bus.
14. **Analysis**. Meters, spectrum, spectrogram and scope of what you are listening to.
15. **Modulation**. All modulators and what they drive. Connect an LFO or envelope to any parameter.
16. **Piano Tutorial Mode**. Shows the notes of the selected track falling onto a piano. Play along.
17. **Project Info**. Name, cover and notes of your project. Everything you save goes with the project.
18. **Shadertoy**. A GLSL visual that reacts to your music. Edit the shader on the right, watch it on the left.
19. **Match Tempo**. Tap along to find the tempo of a recording and set it for the project.

## Anchors: the tour finds its targets by itself

One record, keyed by anchor, describes every step in order. Nothing in it touches the DOM. The
tour resolves the key at show time through a small registry, because panels and header groups are
rebuilt on every screen switch. A key with no registered element shows a centered card.

```ts
// ui/tour/TourAnchor.ts
export type TourAnchor =
    | "menu" | "manuals" | "midi" | "transport" | "timecodes" | "screens"
    | "presets" | "samples" | "soundfonts" | "clips" | "regions" | "devices"
    | "mixer" | "analysis" | "modulation"
    | "piano" | "project" | "shadertoy" | "tap"

// ui/tour/TourAnchors.ts
export namespace TourAnchors {
    export const register = (lifecycle: Lifecycle, element: Element, ...anchors: ReadonlyArray<TourAnchor>): void
    export const resolve = (anchor: TourAnchor): Option<Element>
    export const subscribe = (anchor: TourAnchor, observer: Observer<Option<Element>>): Subscription
}

// ui/tour/TourSteps.ts
export type TourStep = {
    screen: Workspace.ScreenKeys
    placement: "above" | "below" | "left" | "right" | "center"
    headline: string
    text: string
    prepare?: Procedure<StudioService>   // browser tab, clips visible
}
export const TourSteps: Record<TourAnchor, TourStep>
```

- `register` stores `anchor → element` and owns a terminable that deletes the entry (only if it
  still holds that element). `subscribe` lets the running card re-anchor when a panel remounts.
- **Header groups** register in `Header.tsx` (`menu`, `manuals`, `midi`, `transport`,
  `timecodes`, `screens`).
- **Panels** register in ONE place: `PanelContent.#createContent` registers the created content
  element under the keys mapped from `PanelType` (`BrowserPanel → presets, samples, soundfonts`,
  `DevicePanel → devices`, `Analysis → analysis`, `Modulation → modulation`). `mixer` is the first
  channel strip, registered in `Mixer.tsx` on every strip rebuild.
  Because it is the content element, a popped-out panel registers the element in its own window.
- **Timeline** registers `clips` (`ClipsArea`) and `regions` (`RegionsArea`).
- `piano`, `project`, `shadertoy`, `tap` have no element and center in the viewport. `center` with
  an element centers on that element's rect.

`prepare` is the only escape hatch: the three browser steps set `service.layout.browseScope`,
the clips step sets `service.timeline.clips.visible`. `BrowseScope` moved from `BrowserPanel` into
`service.layout.browseScope`. The tour remembers both values on start and restores them on finish.

## Runtime

```
ui/tour/
  TourAnchor.ts      keys
  TourAnchors.ts     registry
  TourSteps.ts       ordered data (above)
  TourCard.tsx/.sass the card
  TourPlacement.ts   pure placement math (tested)
  Tour.ts            controller: offer(), start(), step(), finish()
```

- **Controller** (`Tour.install(service)` from `boot.ts`, next to `StudioShortcutManager.install`).
  Subscribes to `projectProfileService`; on `Some` waits for `layout.screen` to be `"default"` and
  one `AnimationFrame`, then `offer()` unless the preference is off or the session flag is set.
- **Step**: `switchScreen(step.screen)` if different, `prepare?.()`, `AnimationFrame.once`, resolve
  the anchor, position the card, subscribe to the anchor for remounts, `Html.watchResize` on the
  anchor and a `resize` listener on the owner window to reposition.
- **Card** is appended to the `floating` layer of the surface that owns the target element:
  `Surface.get(anchor).floating`, which resolves through `anchor.ownerDocument.defaultView`. A
  target inside a popped-out panel therefore gets its card in that panel's window, and the
  placement math uses that window's `innerWidth`/`innerHeight`. Cards without a target go to the
  main surface. The card is re-created when the owner surface changes between steps, otherwise
  content is swapped in place with a short transition on `transform`. It sits above panels and
  beneath dialogs (dialogs use the top layer).
- **Keys**: `Events.subscribe(window, "keydown", ..., {capture: true})` like `Spotlight`, active
  only while the tour runs, `preventDefault` + `stopPropagation` for the handled keys so shortcuts
  do not fire. The card focuses its `Next` button on every step. Keys are ignored in a text input
  only if the user clicked into it after the card appeared, because the sample browser and the
  Shadertoy Monaco editor steal focus on mount.
- **Placement** (`TourPlacement.ts`): pure function
  `place(anchorRect, cardSize, viewport, preferred) → {x, y, side, notch}`; flips side when the
  preferred one does not fit, clamps to the viewport with a margin, notch offset clamped to the
  card edge minus the corner radius. `"center"` yields no notch. Unit tested with vitest.
- **Style**: `Colors.bright` background, `Colors.dark` text, `1em` radius, soft shadow, max width
  `20em`, notch as a rotated square (`::before`) on the side facing the anchor. Close button top
  right (`IconSymbol.Close`). Target ring: class `tour-target` toggled on the resolved element.
- **Finish/dismiss**: remove card, restore browse scope and clip visibility, `switchScreen("default")`,
  clear `tour-target`, terminate listeners. Project close mid-tour calls the same path.

## Files touched

- `studio/core/src/StudioSettings.ts` add `visibility["offer-studio-tour"]`
- `app/studio/src/ui/pages/PreferencesPageLabels.ts` label
- `app/studio/src/service/StudioService.ts` `layout.browseScope`
- `app/studio/src/ui/browse/BrowserPanel.tsx` bind to `service.layout.browseScope`
- `app/studio/src/ui/header/Header.tsx` register six anchors
- `app/studio/src/ui/workspace/PanelPlaceholder.tsx` register panel anchors by `PanelType`
- `app/studio/src/ui/timeline/Timeline.tsx`, `tracks/audio-unit/AudioUnitsTimeline.tsx` register clips/regions
- `app/studio/src/boot.ts` `Tour.install(service)`
- new `app/studio/src/ui/tour/*`

## Status (2026-09-15)

Implemented and checked in the browser: offer on new project, `Not now`, `Never show this again`
(persists, offer stays away, preference visible on the preferences page), all 19
cards with notch and outline, keyboard, screen switches, finish returns to default with browser
tab and clip visibility restored, Escape, ring only on header groups, mixer card beside the first
strip, devices/analysis centered on their panel, manuals prompt after the last card. Not yet
checked: popped-out panel, abort on project close, resize. Design pass still open (glassy backdrop).

## Phases (browser checkpoint after each)

1. Preference + offer dialog. Card not built, `Start tour` logs. Verify the offer
   appears once per project open, respects checkbox and `Not now`.
2. `TourPlacement` with tests, `TourCard`, `TourAnchors`. Show step 4 (Transport) only.
   Verify notch, clamp, resize, Escape, close button.
3. Full default-screen list (1 to 12) incl. browse scope lifting and clip visibility. Verify
   restore on dismiss.
4. Screen-switching steps (13 to 19), return to default, abort on project close.
5. Copy pass on the 19 texts in the live studio, keep them to two sentences.

## Decisions

- `Not now` only closes the dialog, no flag.
- Card has a `Next` button with the `→` shortcut printed on it.
- Design is deliberately rough in the first pass, glassy backdrop to be tried later.
