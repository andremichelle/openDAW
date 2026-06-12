# Compositor-synced custom scrollbars (scroll-driven animations)

Upgrade for the custom scrollbars in `plans/scrollbars.md`. The baseline pins the injected
`position: absolute` bar to the viewport edge by counter-translating it on every `scroll` event in
JS. Because native scroll runs on the compositor thread while `scroll` events fire on the main
thread, the bar can drift a frame under heavy main-thread load (worst on Safari).

CSS scroll-driven animations remove the JS-per-scroll entirely: the compositor drives the
counter-translate, so the bar is pinned in perfect sync with no main-thread work.

```sass
.custom-scrollbar-host .scrollbar-y
  will-change: transform
  animation: pin-y linear
  animation-timeline: scroll(nearest block)   // self/nearest scroll container

@keyframes pin-y
  to
    transform: translateY(var(--overflow-y))   // scrollHeight - clientHeight
```

Animation progress 0..1 maps to scroll start..end, so `translateY = progress * overflow = scrollTop`
exactly — pinned on the compositor. JS only updates `--overflow-y` (and the thumb size) on
resize/content change, never on scroll. The same timeline can drive the thumb position too.

## Why deferred

`animation-timeline` is **not Baseline** ("Limited availability" per MDN):

- Chrome / Edge: supported (115+).
- Firefox: enabled in 136 (early 2025) — confirm before relying on it.
- Safari / iOS: no stable support as of mid-2026 — the hard blocker.

Since at least one major browser lacks it, it cannot be the baseline. Building it as a two-path
enhancement (JS + scroll-timeline) only pays off once it covers the large majority of users, which
it does not while Safari is out. So the studio ships JS-only counter-translate.

## When to revisit

- Safari ships scroll-driven animations in stable, and Firefox support is confirmed.
- OR phase-1 testing shows the JS counter-translate drift is actually objectionable on real panels,
  making the Chromium-only enhancement worthwhile sooner (gate behind
  `CSS.supports("animation-timeline: scroll()")`, JS fallback otherwise).

## Implementation sketch

- Add the scroll-timeline CSS path behind a `CSS.supports("animation-timeline", "scroll()")` check in
  `installScrollbars`; keep the JS `pin` as the fallback when unsupported.
- Feed `--overflow-x` / `--overflow-y` as CSS vars from the resize handler (already computed for the
  `ScrollModel`).
- Optionally drive the thumb via the same timeline to drop the per-scroll thumb update as well.
