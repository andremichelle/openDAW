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
visual-only, so it does **not** add to `scrollWidth/Height` (using `top/left` would). The only
requirement on the host is `position: relative` (safe — does not change its own box).

### Opt-in API — imperative `installScrollbars(element)`

Each scroll element's owner calls `lifecycle.own(installScrollbars(lifecycle, scrollEl))` on its
element ref. Per the issue idea, orientation is read from CSS, not configured: the installer reads
the element's computed `overflow-x` / `overflow-y` and adds a bar per axis whose value is `auto`,
`scroll`, or `overlay`. Callers keep authoring `overflow` in their `.sass` exactly as today. (~40
one-line call sites — explicit, no DOM magic, no auto-scan `MutationObserver`.)

## New: `bindNativeScroll` (the two-way binding)

Location: `packages/app/studio/src/ui/components/bindNativeScroll.ts`

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

## New: `installScrollbars` (inject + counter-translate)

Location: `packages/app/studio/src/ui/components/installScrollbars.ts`

```tsx
export const installScrollbars = (lifecycle: Lifecycle, element: HTMLElement): Terminable => {
    const terminator = lifecycle.own(new Terminator())
    if (getComputedStyle(element).position === "static") {element.style.position = "relative"}
    element.classList.add("custom-scrollbar-host") // hides the native bar via global CSS
    const style = getComputedStyle(element)
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
- Owner usage: `lifecycle.own(installScrollbars(lifecycle, scrollEl))` where `scrollEl` is the same
  element that today carries `overflow: auto/scroll`. Optional `<Scrollbars/>` child-component sugar
  could wrap this later, but imperative is the baseline.

## Boot capability detection

Hiding native scrollbars works on every browser in active use, but the *one* honest gap (Firefox
< 64, and any future engine that ignores the rules) must degrade gracefully — not show a native bar
*and* our overlay. So probe at boot and gate the whole feature on a body class.

This is **not** part of `features.ts` / `testFeatures()` — that aborts boot with `MissingFeature` for
*required* capabilities. Custom scrollbars are an enhancement, so a missing capability must silently
fall back to native bars, never block boot.

### Probe — `Browser.canHideScrollbars()`

Add to `packages/lib/dom/src/browser.ts`. A measurement probe, uniform across classic and overlay
scrollbars (no engine sniffing):

```ts
canHideScrollbars(): boolean {
    const id = "scrollbar-probe"
    const style = document.createElement("style")
    style.textContent = `.${id}::-webkit-scrollbar{display:none}` // pseudo-element can't be inlined
    const probe = document.createElement("div")
    probe.className = id
    probe.setAttribute("style",
        "position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;" +
        "scrollbar-width:none;-ms-overflow-style:none")
    document.head.appendChild(style)
    document.body.appendChild(probe)
    const hidden = probe.offsetWidth - probe.clientWidth === 0
    probe.remove()
    style.remove()
    return hidden
}
```

`overflow: scroll` forces a bar, then `offsetWidth - clientWidth === 0` (the gutter collapsed) is the
signal:
- classic bars + hide works (Windows/Linux) -> gutter ~15px collapses to 0 -> `true`
- overlay bars (macOS) -> gutter already 0, pseudo kills the transient bar -> `true`
- hide not honored (Firefox < 64) -> gutter stays > 0 -> `false`

### Wire-up — `boot.ts`

After `Surface.main(...)` (so `document.body` exists), one line:

```ts
document.body.classList.toggle("custom-scrollbars", Browser.canHideScrollbars())
```

Boot stashes the boolean on a shared config that `installScrollbars` reads: when unsupported, the
installer **no-ops** (adds no `.custom-scrollbar-host` class, appends no bar), so the native bars
stay and nothing overlays — zero-risk fallback. The `body.custom-scrollbars` class is still handy
for any global tweaks.

## Global CSS: hide native scrollbars

The hide rule is keyed off the `.custom-scrollbar-host` class that `installScrollbars` adds (only
added when supported + installed), so it never touches child windows / code editor / native areas.
Replace the temporary `*` block in `main.sass` with:

```sass
.custom-scrollbar-host
  scrollbar-width: none        // Firefox
  -ms-overflow-style: none     // legacy Edge
  &::-webkit-scrollbar         // Chrome / Safari
    display: none
```

## Migration

For each scroll element, grab its ref and call `lifecycle.own(installScrollbars(lifecycle, el))`.
No CSS change needed (the installer sets `position: relative` if static and reads the existing
`overflow`). Sites with native `overflow: auto/scroll` (grep `overflow.*\(auto\|scroll\)` over
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

Start with 1–2 representative panels (e.g. `PreferencePanel`, `ResourceBrowser`) to validate
positioning, the counter-translate pin, and scroll sync before sweeping the rest.

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
2. `Browser.canHideScrollbars()` probe + boot wire-up + `.custom-scrollbar-host` hide CSS (replace
   the temporary `*` block in `main.sass`).
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
- **`position: relative` on the host**: the installer sets it when the host is `static`. Establishes
  a stacking context — usually harmless; spot-check sites with `z-index` children.
- **Injected child matched by `> *` selectors**: give the bar a unique class.
- **Dynamic content size**: needs `MutationObserver`/`invalidate()` so the thumb resizes when list
  contents change without a host resize.
- **Nested scroll containers**: wheel/drag should affect the innermost; native scroll already handles
  this, our overlay just mirrors — confirm.
