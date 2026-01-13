import css from "./MenuButton.sass?inline"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {MenuItem} from "@moises-ai/studio-core"
import {Menu} from "@/ui/components/Menu.tsx"
import {Color, getOrProvide, isDefined, Option, Procedure, ValueOrProvider} from "@moises-ai/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "MenuButton")

type Appearance = {
    color?: Color
    activeColor?: Color
    framed?: boolean
    tinyTriangle?: boolean
    tooltip?: ValueOrProvider<string>
}

type Construct = {
    root: MenuItem
    onInit?: Procedure<HTMLButtonElement>
    style?: Partial<CSSStyleDeclaration>
    appearance?: Appearance
    horizontal?: "left" | "right"
    stretch?: boolean
    pointer?: boolean
    groupId?: string
}

export const MenuButton =
    ({root, onInit, style, appearance, horizontal, stretch, pointer, groupId}: Construct, children: JsxValue) => {
        let current: Option<Menu> = Option.None
        const button: HTMLButtonElement = (
            <button onInit={onInit}
                    className={Html.buildClassList(className,
                        appearance?.framed && "framed", appearance?.tinyTriangle && "tiny-triangle",
                        stretch && "stretch", pointer && "pointer")}
                    onpointerdown={(event: PointerEvent) => {
                        if (event.ctrlKey || !root.hasChildren) {return}
                        event.stopPropagation()
                        toggle()
                    }}
                    onpointerenter={() => {
                        const focus = button.ownerDocument.activeElement
                        if (focus instanceof HTMLElement
                            && focus.getAttribute("data-menu-group-id") === groupId) {
                            Html.unfocus(focus.ownerDocument.defaultView ?? window)
                            toggle()
                        }
                    }}
                    title={getOrProvide(appearance?.tooltip) ?? ""}>{children}</button>
        )
        if (isDefined(appearance?.color)) {
            button.style.setProperty("--color", appearance.color.toString())
        }
        if (isDefined(appearance?.activeColor)) {
            button.style.setProperty("--color-active", appearance.activeColor.toString())
        }
        if (isDefined(style)) {
            Object.assign(button.style, style)
        }
        const toggle = () => {
            current = current.match({
                none: () => {
                    button.classList.add("active")
                    const rect = button.getBoundingClientRect()
                    const menu = Menu.create(root, groupId)
                    menu.moveTo(rect[horizontal ?? "left"], rect.bottom + Menu.Padding)
                    menu.attach(Surface.get(button).flyout)
                    menu.own({terminate: toggle})
                    return Option.wrap(menu)
                },
                some: menu => {
                    button.classList.remove("active")
                    menu.terminate()
                    return Option.None
                }
            })
        }
        return button
    }