import css from "./Spotlight.sass?inline"
import {Nullable, Option, Point, Terminable, Terminator} from "@moises-ai/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {appendChildren, createElement, replaceChildren} from "@moises-ai/lib-jsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Dragging, Events, Html, Keyboard} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "Spotlight")

export namespace Spotlight {
    export const install = (surface: Surface, service: StudioService) => {
        const position = Point.create(surface.width / 2, surface.height / 3)
        let current: Nullable<HTMLElement> = null
        return Terminable.many(
            Events.subscribe(surface.owner, "keydown", event => {
                const shiftEnter = event.shiftKey && event.code === "Enter"
                const cmdKeyF = Keyboard.isControlKey(event) && event.code === "KeyF"
                if (shiftEnter || cmdKeyF) {
                    event.preventDefault()
                    if (current === null) {
                        const terminator = new Terminator()
                        terminator.own({terminate: () => current = null})
                        current = (
                            <View terminator={terminator}
                                  surface={surface}
                                  service={service}
                                  position={position}/>
                        )
                    } else {
                        current.blur()
                        current?.querySelectorAll<HTMLElement>("*").forEach(element => element.blur())
                    }
                }
            }, {capture: true})
        )
    }

    type Construct = {
        terminator: Terminator
        surface: Surface
        service: StudioService
        position: Point
    }

    export const View = ({terminator, surface, service, position}: Construct) => {
        const inputField: HTMLInputElement = (<input type="text" value="" placeholder="Search anything..."/>)
        const result: HTMLElement = (<div className="result hidden"/>)
        const element: HTMLElement = (
            <div className={className} tabindex={-1}>
                <header>
                    <Icon symbol={IconSymbol.OpenDAW}/>
                    {inputField}
                </header>
                {result}
            </div>
        )
        const updatePosition = () => element.style.transform = `translate(${position.x}px, ${position.y}px)`
        updatePosition()
        terminator.ownAll(
            Dragging.attach(element, ({clientX, clientY}) => {
                const tx = position.x
                const ty = position.y
                return Option.wrap({
                    update: (event: Dragging.Event) => {
                        position.x = tx + event.clientX - clientX
                        position.y = ty + event.clientY - clientY
                        updatePosition()
                    },
                    cancel: () => {
                        position.x = tx
                        position.y = ty
                        updatePosition()
                    },
                    finally: () => inputField.focus()
                })
            }),
            Events.subscribe(inputField, "input", () => {
                const results = service.spotlightDataSupplier.query(inputField.value)
                const hasResults = results.length === 0
                result.classList.toggle("hidden", hasResults)
                replaceChildren(result, results.map(({icon, name}) => (
                    <div className="result-item">
                        <Icon symbol={icon}/>
                        <span>{name}</span>
                    </div>
                )))
            }),
            Events.subscribe(inputField, "keydown", (event) => {
                if (event.code === "Enter") {
                    const results = service.spotlightDataSupplier.query(inputField.value) // TODO keep from last search
                    if (results.length > 0) {
                        results[0].exec()
                        terminator.terminate()
                    }
                } else if (event.code === "CursorDown") {

                }
            }),
            Events.subscribe(element, "focusout", (event: FocusEvent) => {
                const relatedTarget = event.relatedTarget
                if (relatedTarget === null) {
                    terminator.terminate()
                } else if (relatedTarget instanceof Element) {
                    if (!relatedTarget.contains(element) && !element.contains(relatedTarget)) {
                        terminator.terminate()
                    }
                }
            }),
            {
                terminate: () => {
                    if (element.isConnected) {element.remove()}
                }
            }
        )
        requestAnimationFrame(() => {
            inputField.focus()
            inputField.select()
        })
        appendChildren(surface.flyout, element)
        return element
    }
}