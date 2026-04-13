import css from "./AutomationControl.sass?inline"
import {asDefined, ControlSource, Editing, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {AudioUnitTracks, AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {MIDILearning} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "AutomationControl")

const getChildrenBounds = (element: Element, offset: number): DOMRect => {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
        return new DOMRect(rect.left - offset, rect.top - offset,
            rect.width + offset * 2, rect.height + offset * 2)
    }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const child of element.children) {
        const childRect = child.getBoundingClientRect()
        if (childRect.width === 0 && childRect.height === 0) {continue}
        left = Math.min(left, childRect.left)
        top = Math.min(top, childRect.top)
        right = Math.max(right, childRect.right)
        bottom = Math.max(bottom, childRect.bottom)
    }
    if (left === Infinity) {return new DOMRect()}
    return new DOMRect(left - offset, top - offset,
        right - left + offset * 2, bottom - top + offset * 2)
}

const syncIndicator = (indicator: HTMLElement, target: Element, offset: number): void => {
    const bounds = getChildrenBounds(target, offset)
    const offsetParent = indicator.offsetParent
    if (offsetParent === null) {
        indicator.style.left = `${bounds.left}px`
        indicator.style.top = `${bounds.top}px`
    } else {
        const parentRect = offsetParent.getBoundingClientRect()
        indicator.style.left = `${bounds.left - parentRect.left}px`
        indicator.style.top = `${bounds.top - parentRect.top}px`
    }
    indicator.style.width = `${bounds.width}px`
    indicator.style.height = `${bounds.height}px`
}

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    tracks: AudioUnitTracks
    parameter: AutomatableParameterFieldAdapter
    disableAutomation?: boolean
    offset?: number
}

export const AutomationControl = (
    {
        lifecycle,
        editing,
        midiLearning,
        tracks,
        parameter,
        disableAutomation,
        offset
    }: Construct, children: JsxValue) => {
    const indicatorOffset = offset ?? 0
    const element: HTMLElement = (<div className={className}>{children}</div>)
    const target = asDefined(element.firstElementChild, "firstElementChild not defined")
    const indicator: HTMLElement = (<div className="automation-indicator hidden"/>)
    element.appendChild(indicator)
    let syncSubscription: Terminable = Terminable.Empty
    let sourceCount = 0
    lifecycle.ownAll(
        attachParameterContextMenu(editing, midiLearning, tracks, parameter, target, disableAutomation),
        parameter.catchupAndSubscribeControlSources({
            onControlSourceAdd: (source: ControlSource) => {
                indicator.classList.add(source)
                if (sourceCount++ === 0) {
                    indicator.classList.remove("hidden")
                    syncSubscription = AnimationFrame.add(() => syncIndicator(indicator, target, indicatorOffset))
                }
            },
            onControlSourceRemove: (source: ControlSource) => {
                indicator.classList.remove(source)
                if (--sourceCount === 0) {
                    syncSubscription.terminate()
                    syncSubscription = Terminable.Empty
                    indicator.classList.add("hidden")
                }
            }
        }),
        parameter.registerTracks(tracks),
        ...(disableAutomation === true ? [] : [
            Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                if (event.buttons !== 1) {return}
                console.debug("touchStart")
                parameter.touchStart()
            }, {capture: true}),
            Events.subscribe(element, "pointerup", () => parameter.touchEnd(), {capture: true}),
            Events.subscribe(element, "pointercancel", () => parameter.touchEnd(), {capture: true})
        ]),
        Terminable.create(() => syncSubscription.terminate())
    )
    return element
}
