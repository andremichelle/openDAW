import css from "./Menu.sass?inline"
import {DefaultMenuData, HeaderMenuData, InputValueMenuData, MenuItem} from "@/ui/model/menu-item.ts"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {int, isDefined, Lifecycle, Nullable, Option, panic, Terminable, Terminator} from "@opendaw/lib-std"
import {Icon} from "@/ui/components/Icon.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "menu")

export const HeaderMenuDataElement = ({data}: { data: HeaderMenuData }) => (
    <div className={Html.buildClassList("header")}
         style={{"--color": data?.color?.toString() ?? Colors.gray.toString()}}>
        <div className="icon-space"/>
        {data.icon && <Icon symbol={data.icon} style={{margin: "0 0.25em", fontSize: "1.25em"}}/>}
        <div className="label">{data.label}</div>
        <div className="shortcut"/>
    </div>
)

export const DefaultMenuDataElement = ({data}: { data: DefaultMenuData }) => (
    <div className={Html.buildClassList("default", data.checked && "checked")}>
        <svg classList="check-icon" viewBox="0 0 12 12">
            <path d="M2 7L5 10L10 3"/>
        </svg>
        {data.icon && <Icon symbol={data.icon} style={{margin: "0 0.25em", fontSize: "1.25em"}}/>}
        <div className="label">{data.label}</div>
        <div className="shortcut">{[...data.shortcut ?? []].map(s => <span>{s}</span>)}</div>
        <svg classList="children-icon" viewBox="0 0 12 12">
            <path d="M4 2L8 6L4 10"/>
        </svg>
    </div>
)

export const ValueSliderMenuDataElement = ({data: {icon, model, name, unit, color}}: { data: InputValueMenuData }) => (
    <div className="input-value"
         style={{"--color": color?.toString() ?? Colors.gray.toString()}}>
        <Icon symbol={icon} style={{margin: "0 0.25em", fontSize: "1.25em"}}/>
        <div className="name">{name}</div>
        <input type="range" min="0" max="1" step="any" data-close-on-blur={true} onInit={element => {
            element.valueAsNumber = model.getValue()
            element.oninput = () => model.setValue(element.valueAsNumber)
        }}/>
        <div className="unit">{unit}</div>
    </div>
)

type MenuHtmlStructure = {
    element: HTMLElement
    scrollUp: HTMLElement
    container: HTMLElement
    scrollDown: HTMLElement
}

export class Menu implements Terminable, Lifecycle {
    static create(item: MenuItem, groupId?: string): Menu {
        const oldFocus = document.activeElement
        const menu = new Menu(Option.None, item, groupId ?? "")
        if (oldFocus instanceof HTMLElement) {
            menu.own(Terminable.create(() => oldFocus.focus()))
        }
        return menu
    }

    static Padding = 4 // this is the invisible increase of the hitarea to have seamless connection to the source element
    static MIN_TIME_MS = 250 // if the menu is placed under the pointer, we avoid an accidental click

    readonly #terminator: Terminator
    readonly #parent: Option<Menu>
    readonly #item: MenuItem
    readonly #groupId: string

    readonly #element: HTMLElement
    readonly #scrollUp: HTMLElement
    readonly #container: HTMLElement
    readonly #scrollDown: HTMLElement
    readonly #openTime: number

    #childMenu: Option<Menu> = Option.None

    #x: int = 0
    #y: int = 0

    private constructor(parent: Option<Menu>, item: MenuItem, groupId: string) {
        this.#terminator = new Terminator()

        this.#parent = parent
        this.#item = item
        this.#groupId = groupId

        const {element, scrollUp, container, scrollDown} = this.#createHtml()
        this.#element = element
        this.#scrollUp = scrollUp
        this.#container = container
        this.#scrollDown = scrollDown
        this.#openTime = Date.now()

        this.#element.onblur = (event) => {
            const related = event.relatedTarget
            if (related === null) {
                // lost focus
                this.root.terminate()
            } else if (related instanceof HTMLElement && !isDefined(related.getAttribute("data-close-on-blur"))) {
                // an unrelated element has been focussed
                this.root.terminate()
            }
        }
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}
    ownAll<T extends Terminable>(...terminables: Array<T>): void {this.#terminator.ownAll(...terminables)}
    spawn(): Terminator {return this.#terminator.spawn()}

    get root(): Menu {return this.#parent.isEmpty() ? this : this.#parent.unwrap().root}
    get element(): HTMLElement {return this.#element}

    moveTo(x: int, y: int): void {
        this.#x = x | 0
        this.#y = y | 0
        this.#element.style.transform = `translate(${this.#x}px, ${this.#y}px)`
    }

    attach(parentElement: Element): void {
        parentElement.appendChild(this.#element)
        const {right, bottom, width, height} = this.#element.getBoundingClientRect()
        const owner = Surface.get(parentElement).owner
        const innerWidth = owner.innerWidth
        const innerHeight = owner.innerHeight
        const offset = parseFloat(getComputedStyle(this.#element).fontSize) / 4
        if (right > innerWidth) {
            this.#parent.match({
                none: () => this.moveTo(innerWidth - width - offset, this.#y),
                some: () => this.moveTo(offset - width, this.#y)
            })
        }
        if (height > innerHeight) {
            this.#setupScrolling()
            this.moveTo(this.#x, -parentElement.getBoundingClientRect().top)
        } else if (bottom > innerHeight) {
            this.moveTo(this.#x, this.#y - bottom + innerHeight)
        }
        AnimationFrame.once(() => this.#element.focus())
    }

    terminate(): void {
        this.#childMenu.ifSome(menu => menu.terminate())
        this.#childMenu = Option.None
        this.#changeSelected()
        this.#element.onblur = null
        this.#element.remove()
        this.#item.removeRuntimeChildren()
        this.#terminator.terminate()
    }

    #onPointerEnter(item: MenuItem, itemElement: HTMLElement): void {
        this.#changeSelected(itemElement)
        if (this.#childMenu.nonEmpty()) {
            if (item.hasChildren && this.#childMenu.unwrap().#item === item) {
                // no need to remove and recreate the same pull-down
                return
            }
            this.#closeChildMenu()
        }
        if (item.hasChildren) {
            const itemRect = itemElement.getBoundingClientRect()
            const elementRect = this.#element.getBoundingClientRect()
            const childMenu = new Menu(Option.wrap(this), item, this.#groupId)
            const em = parseFloat(getComputedStyle(this.#element).fontSize)
            childMenu.moveTo(elementRect.width - em / 4, (itemRect.top - elementRect.top) - em)
            childMenu.attach(this.#element)
            this.#childMenu = Option.wrap(childMenu)
        }
    }

    #onPointerLeave(_item: MenuItem, itemElement: HTMLElement, event: PointerEvent): void {
        if (this.#isChild(event.relatedTarget as Node)) {return}
        itemElement.classList.remove("selected")
        this.#closeChildMenu()
    }

    #onPointerUp(item: MenuItem, _itemElement: HTMLElement, event: PointerEvent): void {
        event.preventDefault()
        if (this.#childMenu.isEmpty()) {
            this.root.terminate()
            item.trigger()
        }
    }

    #changeSelected(element: Nullable<HTMLElement> = null) {
        this.#element.querySelector(".selected")?.classList.remove("selected")
        element?.classList.add("selected")
    }

    #isChild(node: Nullable<Node>): boolean {
        if (this.#childMenu.isEmpty()) {
            return false
        }
        const childMenu = this.#childMenu.unwrap()
        let target: Nullable<Node> = node
        while (null !== target) {
            if (target === this.#element) {return false}
            if (target === childMenu.#element) {return true}
            target = target.parentNode
        }
        return false
    }

    #closeChildMenu(): void {
        if (this.#childMenu.isEmpty()) {return}
        this.#element.focus()
        this.#childMenu.unwrap().terminate()
        this.#childMenu = Option.None
    }

    #createHtml(): MenuHtmlStructure {
        const scrollUp = <div className="scroll up"><Icon symbol={IconSymbol.RoundUp}/></div>
        const scrollDown = <div className="scroll down"><Icon symbol={IconSymbol.RoundDown}/></div>
        const container = <div className="container">
            {
                this.#item.collectChildren()
                    .filter((item: MenuItem) => !item.hidden)
                    .map((item: MenuItem) => {
                        item.open()
                        const hasChildren = item.hasChildren
                        const selectable = item.selectable
                        const itemElement: HTMLElement = (
                            <div className="item">
                                {(() => {
                                    if (item.data === undefined) {
                                        return panic("")
                                    } else if (item.data.type === "header") {
                                        return <HeaderMenuDataElement data={item.data}/>
                                    } else if (item.data.type === "default") {
                                        return <DefaultMenuDataElement data={item.data}/>
                                    } else if (item.data.type === "input-value") {
                                        return <ValueSliderMenuDataElement data={item.data}/>
                                    }
                                })()}
                            </div>
                        )
                        if (selectable) {
                            itemElement.classList.add("selectable")
                        }
                        if (hasChildren) {
                            itemElement.classList.add("has-children")
                        }
                        itemElement.onpointerenter = () => this.#onPointerEnter(item, itemElement)
                        itemElement.onpointerleave = (event: PointerEvent) => this.#onPointerLeave(item, itemElement, event)
                        itemElement.onpointerup = (event: PointerEvent) => {
                            if (Date.now() - this.#openTime < Menu.MIN_TIME_MS) {return}
                            this.#onPointerUp(item, itemElement, event)
                        }
                        return (
                            <Frag>
                                {item.separatorBefore && <hr/>}
                                {itemElement}
                            </Frag>
                        )
                    })
            }
        </div>
        const element = (
            <nav className={className} tabIndex={-1} data-close-on-blur={true} data-menu-group-id={this.#groupId}>
                {scrollUp}
                {container}
                {scrollDown}
            </nav>
        )
        return {element, scrollUp, container, scrollDown}
    }

    #setupScrolling(): void {
        const scroll = (direction: int) => this.#container.scrollTop += direction * this.#computeEmInPixels() / 3
        this.element.classList.add("overflowing")
        this.#terminator.own(Events.subscribe(this.element, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            scroll(Math.sign(event.deltaY) * this.#computeEmInPixels() * 1.5)
        }, {passive: false}))
        const setup = (button: HTMLElement, direction: number) => {
            const scrolling = new Terminator()
            button.onpointerenter = () => {
                if (!this.#canScroll(direction)) {return}
                scrolling.own(AnimationFrame.add(() => {
                    if (this.#canScroll(direction)) {
                        scroll(direction)
                    } else {
                        scrolling.terminate()
                    }
                }))
                button.onpointerleave = () => scrolling.terminate()
            }
        }
        setup(this.#scrollUp, -1)
        setup(this.#scrollDown, 1)
    }

    #canScroll(direction: number): boolean {
        return (0 > direction && this.#container.scrollTop > 0)
            || (0 < direction && this.#container.scrollTop < this.#container.scrollHeight - this.#container.clientHeight)
    }

    #computeEmInPixels(): number {return parseInt(getComputedStyle(this.#element).fontSize)}
}