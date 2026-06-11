# Toasts

Lightweight transient notifications shown top/center for 3 seconds. Newer toasts stack first
(on top) so the most recent is closest to the top edge.

## Component: `Toast.tsx` + `Toast.sass`

Location: `packages/app/studio/src/ui/surface/Toast.tsx` (next to `Surface.tsx`).

```tsx
import css from "./Toast.sass?inline"

export const Toast = ({text, icon}: {text: string, icon: IconSymbol}): HTMLElement => {
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={icon}/>
            <span>{text}</span>
        </div>
    )
    Wait.timeSpan(TimeSpan.seconds(3))
        .then(() => element.classList.add("leaving"))
        .then(() => Wait.event(element, "transitionend"))
        .then(() => element.remove())
    return element
}
```

- `icon: IconSymbol` is required on the component. The default (notification icon) is applied by
  the Surface method, not here.
- Auto-dismiss: `Wait.timeSpan(TimeSpan.seconds(3))` then add `leaving` class for a fade/slide-out
  CSS transition, then `Wait.event(element, "transitionend")` before `element.remove()` (no
  hardcoded duration).
- `Toast.sass`: row layout (icon + text), padding, rounded background, subtle shadow, enter/leave
  transitions (opacity + translateY). No positioning here. positioning lives on the layer container.

## Surface changes

`packages/app/studio/src/ui/surface/Surface.tsx`

- Add a 4th layer field `#toasts: DomElement` alongside `#ground` / `#flyout` / `#floating`.
- Create as `<div className="toasts"/>` and append it last inside the root div in the constructor
  (after `#floating`) so it renders above the other layers.
- Add method:

```ts
toast(text: string, icon: IconSymbol = IconSymbol.Notification): void {
    this.#toasts.prepend(Toast({text, icon}))
}
```

`prepend` puts new toasts first in the list (top), matching "if there are more, they appear first".

`Surface.sass`

- Add a `> div.toasts` rule. Unlike the `display: contents` layers, this one is positioned:
  `position: fixed; top; left: 50%; transform: translateX(-50%)`, column flex with a gap,
  `pointer-events: none`, high `z-index`, centered items.

## Icon: add `Notification` symbol

Add a new `Notification` entry to the `IconSymbol` enum in
`packages/studio/enums/src/IconSymbol.ts`, then register its glyph in
`packages/app/studio/src/ui/IconLibrary.tsx` (viewBox `0 0 24 24`, `fill="currentColor"`, drop the
`fill="none"` background rect):

```tsx
<symbol id={IconSymbol.toName(IconSymbol.Notification)} fill="currentColor" stroke="none"
        viewBox="0 0 24 24">
    <path d="M18 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6"/>
    <path d="M5 4c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h13c1.1 0 2-.9 2-2v-8.99c-.61.3-1.28.49-2 .49c-2.48 0-4.5-2.02-4.5-4.5c0-.72.19-1.39.49-2z"/>
</symbol>
```

The `toast` method then defaults to `icon: IconSymbol = IconSymbol.Notification`.

## Mock shortcut in boot

`packages/app/studio/src/boot.ts`, after the existing `subscribeKeyboard` (line 118):

```ts
Surface.subscribeKeyboard("keydown", event => {
    if (event.code === "KeyT" && event.altKey && !Events.isTextInput(event.target)) {
        event.preventDefault()
        Surface.get().toast(`Toast ${new Date().toLocaleTimeString()}`)
    }
})
```

Press Alt+T to spawn a test toast (guarded by `Events.isTextInput` so it ignores text fields).
Repeat presses stack, newest on top, each clears after 3 seconds. Remove this block once toasts are
wired to real events.
