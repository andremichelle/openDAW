# Custom Scrollbars (#260)

Different browsers ship different native scrollbars (Firefox's are the bulkiest). Replace them with
our own thin, consistent overlay scrollbars that look identical on every browser and OS.

## Strategy: keep native scroll, replace only the visuals

Do **not** reimplement scrolling. Every native `overflow: auto/scroll` container keeps its native
scroll behavior (wheel, trackpad momentum, keyboard, `scrollIntoView`, focus handling, touch,
content layout, accessibility). We only:

1. **Hide** the native scrollbar visually.
2. **Overlay** our own thumb that mirrors `scrollTop`/`scrollLeft` and writes back on drag.

We **reuse** the existing `Scroller.tsx` + `ScrollModel.ts` + `Scroller.sass` (in
`packages/app/studio/src/ui/components/`) as the visual + drag layer. No new thumb/track rendering,
no new drag code, no new look — the design is whatever those already produce.

### The template already exists

Two shipping call sites already bind the `Scroller` to a **native-scroll** container — they are the
exact pattern to generalize, not a new invention:

- **Vertical — `ui/timeline/tracks/audio-unit/AudioUnitsTimeline.tsx`** is the full two-way bind:
  - `87`  `<Scroller lifecycle={lifecycle} model={scrollModel} floating/>`
  - `107` `scrollModel.visibleSize = scrollContainer.clientHeight`
  - `108` `scrollModel.contentSize = scrollContainer.scrollHeight`
  - `115` `scrollModel.subscribe(() => scrollContainer.scrollTop = scrollModel.position)` (model -> native)
  - `116` `Events.subscribe(scrollContainer, "scroll", () => scrollModel.position = scrollContainer.scrollTop)` (native -> model)
  - `114` wheel -> `scrollModel.position += event.deltaY`
- **Horizontal, floating — `ui/devices/panel/DevicePanel.tsx`** (`235-236`, `266-269`): same idea,
  one-directional (`devices.scrollLeft = scrollModel.position`) with wheel/auto-scroll routed
  through the model.

`bindNativeScroll` below is just lines 107-116 extracted into a reusable helper. It already runs in
production, so the approach is proven, not speculative.

Note: `Scroller`/`ScrollModel` were originally built model-driven (Mixer translates content), but the
timeline/DevicePanel usage shows the same component drives a native-scroll element unchanged.

## No wrapper — inject the bar into the scroll element

A `ScrollArea` wrapper is rejected: wrapping the ~40 heterogeneous containers would break `>` child
selectors and flex/grid layouts. Instead the bar is **appended as a child of the scroll element
itself**, `position: absolute`, taking no layout space (out of flow, so it is *not* a flex/grid item
and reserves no space — `position: sticky` was ruled out precisely because it *would* be an in-flow
item).

One consequence of CSS: an `position: absolute` child of a scroll container **scrolls with the
content** (the scroll offset is applied to abs descendants whose containing block is the scroller).
So the bar must be **counter-translated** by the scroll offset on every `scroll`/`resize` to stay
pinned to the viewport edge — `transform: translate(scrollLeft, scrollTop)`. `transform` is
visual-only, so it does **not** add to `scrollWidth/Height` (using `top/left` would).

The host must be a containing block (non-`static` position) for the bar to anchor to it. The
installer does **not** mutate the host — it would silently re-anchor the host's existing abs
descendants. Instead it **throws** if the host computes `position: static` — which, read via `getComputedStyle`,
also covers a host with no `position` set at all (unset resolves to `static`). That specific site
is handled deliberately (add `position: relative` to that host's own `.sass` after checking it has
no abs descendants that would re-anchor, or solve it another way for that one case). Fail-fast over
a hidden global side effect.

### Opt-in API — imperative `installScrollbars(element)`

Each scroll element's owner calls `lifecycle.own(installScrollbars(lifecycle, scrollEl))` on its
element ref. Per the issue idea, orientation is read from CSS, not configured: the installer reads
the element's computed `overflow-x` / `overflow-y` and adds a bar per axis whose value is `auto`,
`scroll`, or `overlay`. Callers keep authoring `overflow` in their `.sass` exactly as today. (~40
one-line call sites — explicit, no DOM magic, no auto-scan `MutationObserver`.)

## New file: `Scrollbars.tsx`

Both `bindNativeScroll` and `installScrollbars` live in one file,
`packages/app/studio/src/ui/components/Scrollbars.tsx` (`.tsx` because `installScrollbars` uses JSX).
`isScrollableOverflow` is a small private helper in the same file.

### `bindNativeScroll` (the two-way binding)

Binds one axis of a native-scroll `viewport` element to a `ScrollModel` so the existing `Scroller`
renders/drag-controls it. This is `AudioUnitsTimeline.tsx:107-116` generalized over orientation:

```ts
export const bindNativeScroll = (viewport: HTMLElement, model: ScrollModel,
                                 orientation: Orientation): Terminable => {
    const vertical = orientation === Orientation.vertical
    const refresh = () => {
        model.visibleSize = vertical ? viewport.clientHeight : viewport.clientWidth
        model.contentSize = vertical ? viewport.scrollHeight : viewport.scrollWidth
        model.position = vertical ? viewport.scrollTop : viewport.scrollLeft
    }
    refresh()
    return Terminable.many(
        model.subscribe(() => {
            if (vertical) {viewport.scrollTop = model.position} else {viewport.scrollLeft = model.position}
        }),
        Events.subscribe(viewport, "scroll", refresh, {passive: true}),
        Html.watchResize(viewport, refresh))
}
```

Notes:
- **No reentrancy guard needed** — exactly as the timeline ships today. `model -> scrollTop` then the
  resulting `scroll` event writes the same `position` back; `ScrollModel.normalized`/`position`
  setters no-op on equal values, so it converges in one step. (If the `Math.floor` in
  `position` ever causes a 1px oscillation at the extremes, compare before writing — the timeline
  does not need this in practice.)
- `Html.watchResize` only observes the host box. Content growth/shrink that does not change the host
  size must also refresh sizes — add a `MutationObserver(childList+subtree)` on the element, or
  expose an imperative `invalidate()` for dynamic-list owners. Pick `MutationObserver` for a drop-in
  feel; revisit if it shows up in profiling (per repo perf rule: measure before optimizing).
- `ScrollModel.position` setter already clamps via `normalized`; the getter's `Math.floor` does not
  cause a 1px drift loop in the timeline today. If it ever does, compare before writing `scrollTop`.

### `installScrollbars` (inject + counter-translate)

Same file. Follows the repo convention: returns a `Terminable`, the caller owns it
(`lifecycle.own(installScrollbars(el))`) — no `lifecycle` parameter threaded in, exactly like
`Events.subscribe` / `Html.watchResize` / `bindNativeScroll`.

```tsx
export const installScrollbars = (element: HTMLElement): Terminable => {
    const style = getComputedStyle(element) // computed, not element.style — unset resolves to "static"
    if (style.position === "static") {
        return panic(`installScrollbars: host must be positioned (non-static), got '${style.position}'`)
    }
    const terminator = new Terminator()
    const orientations: Array<Orientation> = []
    if (isScrollableOverflow(style.overflowY)) {orientations.push(Orientation.vertical)}
    if (isScrollableOverflow(style.overflowX)) {orientations.push(Orientation.horizontal)}
    const bars: Array<HTMLElement> = orientations.map(orientation => {
        const model = terminator.own(new ScrollModel())
        const bar: HTMLElement = <Scroller lifecycle={terminator} model={model} orientation={orientation} floating/>
        element.appendChild(bar)
        terminator.own(bindNativeScroll(element, model, orientation))
        return bar
    })
    const pin = () => {
        const transform = `translate(${element.scrollLeft}px, ${element.scrollTop}px)`
        bars.forEach(bar => bar.style.transform = transform)
    }
    pin()
    terminator.ownAll(
        Events.subscribe(element, "scroll", pin, {passive: true}),
        Html.watchResize(element, pin))
    return terminator
}
```

- `isScrollableOverflow(value)` matches `auto | scroll | overlay`.
- The appended `<Scroller floating>` is `position: absolute` (right/bottom 0, full host client
  size) — no layout space. The `pin` counter-translate keeps it at the viewport edge as the host
  scrolls. Write the transform **synchronously in the `scroll` handler** (no rAF/debounce) so it
  lands in the same frame as the scroll; add `will-change: transform` to the bar.
- `bindNativeScroll` already adds its own `scroll`/`resize` listeners for the model; `pin` adds a
  second pair. Fine for clarity; merge into one handler if it ever matters.
- Give the bar a unique class so existing `.host > *` child selectors do not accidentally style it.
- Native bars are hidden by **one global rule** (see below) — the installer never tags the host.
- Owner usage: `lifecycle.own(installScrollbars(scrollEl))` where `scrollEl` is the same element that
  today carries `overflow: auto/scroll`. Optional `<Scrollbars/>` child-component sugar could wrap
  this later, but imperative is the baseline.

## Boot capability detection — dropped (unnecessary)

Considered a `Browser.canHideScrollbars()` probe at boot to gate the feature, but dropped it: the
hide rules work on every browser in use. `::-webkit-scrollbar { display: none }` covers all
WebKit/Blink (every version); `scrollbar-width: none` covers Firefox 64+ (Dec 2018). The only gap is
Firefox < 64 — effectively extinct. So the probe + body-class + no-op fallback was dead complexity
guarding a non-existent case. Ship the global hide unconditionally instead.

## Global CSS: hide native scrollbars

One unconditional global rule in `main.sass`. `scrollbar-width` is **not** inherited, so it must
target `*` (a `:root` rule would only affect the root element):

```sass
*
  scrollbar-width: none        // Firefox 64+
  -ms-overflow-style: none     // legacy Edge
  &::-webkit-scrollbar         // Chrome / Safari / Blink
    display: none
```

Consequence: this hides native bars **everywhere**, including areas we deliberately left native
(code-editor `.status`, chat textarea, skipped pages). Monaco draws its **own** (non-native) bars so
it is unaffected; the rest are small/rare-scroll surfaces where no visible bar is acceptable. If a
specific area ever needs its native bar back, give it an opt-out class and exclude it from this rule.

## Migration

For each scroll element, grab its ref and call `lifecycle.own(installScrollbars(el))` (via the
element's `onConnect` so it runs once connected). The installer reads the host's computed `overflow`
to pick axes and mounts the bar overlay into the host's `offsetParent`. The host does **not** need to
be positioned (the overlay lives in the offsetParent, not the host). If the host is hidden
(`display: none`) at connect time — overlays/dialogs — it has no `offsetParent` yet, so the installer
**defers** and mounts when the host first becomes visible (`watchResize`).

Gutter: flex/block hosts take a plain `padding-right`. **Subgrid** hosts can't (Firefox ignores
container padding on inherited tracks) — reserve the gutter with a `margin-right` on the rightmost
grid item (e.g. `.delete-icon`), or `minmax(Xpx, auto)` on the last column when the rightmost cell is
sometimes empty. Also set `overflow: hidden scroll` on subgrid hosts so `overflow-x` doesn't compute
to `auto` and spawn a phantom horizontal bar.

Sites with native `overflow: auto/scroll` (grep `overflow.*\(auto\|scroll\)` over
`packages/app/studio/src/**/*.sass`, ~40):

- `ui/PreferencePanel.sass`, `ui/pages/PreferencesPage.sass`
- `ui/ChatOverlay.sass`, `ui/spotlight/Spotlight.sass`
- `ui/code-editor/CodeEditorPanel.sass` (consider leaving the code editor on native)
- `ui/NotePadPanel.sass`, `ui/dashboard/DemoProjects.sass`
- `ui/components/ShortcutManagerView.sass`, `ui/components/BoxesDebugView.sass`
- `ui/browse/PresetBrowser.sass`, `ui/browse/ResourceBrowser.sass`
- `ui/timeline/editors/value/ValueEditorHeader.sass`, `.../audio/AudioEditorHeader.sass`, `.../notes/NoteEditor.sass`
- `ui/pages/*` (Sample/Performance/Components/Test/Icons/Errors/SampleRead/Manual/Privacy/Spike/Automation/Imprint/OpenBundle)
- `ui/devices/audio-effects/NeuralAmp/NamModelDialog.sass`, `ui/devices/instruments/MIDIOutputEditor/ControlValues.sass`
- `project/ProjectBrowser.sass`, `project/NextcloudBrowser.sass`
- `service/ExportStemsConfigurator.sass`
- error/stats pages: `ui/pages/errors/{Stack,Logs}.sass`, `ui/pages/stats/DashboardPage.sass`

### Excluded — keep native scrollbars

- **All code editors** — `CodeEditorPanel` and scriptable-device editors. Monaco manages its own
  scrolling (`overflow: hidden` host, internal bars); leave them native. (Decided 2026-06-15.)
- **Chat input textarea** — a `<textarea>` can't host the overlay child and auto-grows. Skipped.
- **Timeline editor headers** (`ValueEditorHeader`, `AudioEditorHeader`, `NoteEditor` pitch-header) —
  rarely overflow, so a bar would almost never appear. Reverted.

### Done

Project list, Template list, Sample/Soundfont (`ResourceBrowser`), Preset tree, `PreferencePanel`,
`ShortcutManagerView`, `NotePadPanel`, `DemoProjects`, `NextcloudBrowser`, `ControlValues`,
`NamModelDialog`, `ExportStemsConfigurator`, `ChatOverlay` `.messages`, `stats/DashboardPage`
(full page), `ProjectProfileInfo` (Project Info — had no `overflow`, added `hidden auto`).
`PreferencesPage` already correct (page root `overflow: hidden`; only its inner `PreferencePanel` /
`ShortcutManagerView` lists scroll, already wired).

Also done: `ManualPage` (both `aside` + `div.manual`), `PrivacyPage`, `ImprintPage`.

Skipped per decision (low value / not applicable): `PerformancePage`, `SampleReadPage` (dev
benchmark), `AutomationPage`, the `errors/*` pages, `OpenBundlePage` (transient bundle loader), and
the dev/test pages (`ComponentsPage`, `TestPage`, `IconsPage`, `SpikeTestPage`, `BoxesDebugView`).

`ChatOverlay` needed a prerequisite fix: its pin-to-bottom `AnimationFrame(scrollToBottom)` was tied
to `sendOnEnter` start + `transitionend` stop, so with no textarea transition it ran forever and
blocked scroll-up. Now tied to `transitionstart` → `transitionend` (only pins during an actual
transition), so manual scroll-up works and the custom bar coexists.

## Remove the `scrollbar-padding` workaround

Overlay scrollbars take no layout space, so the "Add scrollbar padding" preference is obsolete:

- `service/StudioService.ts:578` — drop the `scrollbar-padding` body-class toggle.
- `ui/pages/PreferencesPageLabels.ts:13` and the preference entry — remove the option.
- The 5 `.scrollbar-padding &` rules: `PreferencePanel.sass`, `components/ShortcutManagerView.sass`,
  `browse/ResourceBrowser.sass`, `project/ProjectBrowser.sass`, `project/NextcloudBrowser.sass`.

Do this only after the migrated panels are confirmed working.

## Visual design = existing `Scroller.sass`

No new look is designed. The thumb is whatever `Scroller.sass` already renders on the timeline and
DevicePanel: `0.5em` thin track, rounded thumb, `rgba(white, 0.125)` resting / `rgba(white, 0.25)`
on `:active`, `floating` = `position: absolute` overlay taking no layout space. Match it exactly so
every scroll area looks like the timeline/DevicePanel bars users already see.

### First iteration: always visible (no auto-hide)

For testing, the thumb stays visible at all times whenever the axis is scrollable — exactly like the
timeline/DevicePanel today (`Scroller` already does `thumb.style.visibility = model.scrollable()`).
Do **not** add the idle/hover fade yet; persistent bars make it obvious every scroll area is wired
up correctly. The fade is deferred polish below.

## Polish (optional, after core works)

- Auto-hide: thumb at low opacity, fade in on hover/scroll, fade out after idle (matches "slick").
  Drive via a `scrolling` class toggled on `scroll` with a debounce. Deferred — ship always-visible
  first.
- Hover-to-thicken thumb.
- Respect `prefers-reduced-motion` for the fade.

Guaranteed compositor-synced pinning via CSS scroll-driven animations (`animation-timeline:
scroll()`) is deferred to `future-plans/scroll-driven-scrollbars.md` — not Baseline (no Safari, and
not relied on), so the JS counter-translate is the baseline everywhere.

## Phases

1. `bindNativeScroll` + `installScrollbars`; install on **one heavy panel** and eyeball the
   counter-translate **scroll sync under load** (Safari especially) — this is the gating risk. Verify
   thumb tracks `scrollTop`, drag writes back, and the bar stays pinned to the edge during fast/
   momentum scroll.
2. Global native-bar hide: one unconditional `*` rule in `main.sass` (no boot probe — see above).
3. Migrate `PreferencePanel` and `ResourceBrowser`; verify both axes in Chrome + Firefox + Safari.
4. Sweep remaining ~40 sites.
5. Remove `scrollbar-padding` preference and its rules.
6. Optional auto-hide/hover polish.

## Risks

- **Scroll sync (the gating risk)**: the bar is a scrolling child counter-translated by JS on
  `scroll`; native scroll is compositor-driven, so under heavy main-thread load the `scroll` handler
  can lag a frame and the whole bar drifts off the edge, then snaps back. Worst on Safari (no
  compositor-synced fallback). Mitigate with synchronous transform writes + `will-change`; validate
  in phase 1 before committing to the sweep.
- **Static host**: the installer throws on a `position: static` host rather than mutating it (would
  re-anchor the host's existing abs descendants). Each thrown site is fixed deliberately — add
  `position: relative` to that host's own `.sass` after checking for abs descendants.
- **Injected child matched by `> *` selectors**: give the bar a unique class.
- **Dynamic content size**: needs `MutationObserver`/`invalidate()` so the thumb resizes when list
  contents change without a host resize.
- **Nested scroll containers**: wheel/drag should affect the innermost; native scroll already handles
  this, our overlay just mirrors — confirm.
