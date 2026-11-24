import css from "./AutomationControl.sass?inline"
import {asDefined, ControlSource, Editing, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {AudioUnitTracks, AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {MIDILearning} from "@opendaw/studio-core"
import {MapTarget} from "@/ui/midi-mapping/MapTarget"

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
        const {clientLeft, clientTop, scrollLeft, scrollTop} = offsetParent
        indicator.style.left = `${bounds.left - parentRect.left - clientLeft + scrollLeft}px`
        indicator.style.top = `${bounds.top - parentRect.top - clientTop + scrollTop}px`
    }
    indicator.style.width = `${bounds.width}px`
    indicator.style.height = `${bounds.height}px`
}

/// The control-source ring every automatable control shows: it follows the control's own bounds and lights
/// up per source (automation, midi, modulation, external).
export const installControlSourceIndicator = (lifecycle: Lifecycle,
                                              midiLearning: MIDILearning,
                                              parameter: AutomatableParameterFieldAdapter,
                                              host: HTMLElement,
                                              target: Element,
                                              offset: number = 0): void => {
    const indicator: HTMLElement = (<div className="automation-indicator hidden"/>)
    host.appendChild(indicator)
    let syncSubscription: Terminable = Terminable.Empty
    let sourceCount = 0
    const updateVisibility = () => {
        const visible = sourceCount > 0 || midiLearning.mapMode.getValue()
        if (visible === !indicator.classList.contains("hidden")) {return}
        indicator.classList.toggle("hidden", !visible)
        syncSubscription.terminate()
        syncSubscription = visible ? AnimationFrame.add(() => syncIndicator(indicator, target, offset)) : Terminable.Empty
    }
    lifecycle.ownAll(
        parameter.catchupAndSubscribeControlSources({
            onControlSourceAdd: (source: ControlSource) => {
                indicator.classList.add(source)
                sourceCount++
                updateVisibility()
            },
            onControlSourceRemove: (source: ControlSource) => {
                indicator.classList.remove(source)
                sourceCount--
                updateVisibility()
            }
        }),
        midiLearning.mapMode.catchupAndSubscribe(updateVisibility),
        MapTarget.frame(midiLearning, parameter.field, indicator),
        Terminable.create(() => syncSubscription.terminate())
    )
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
    installControlSourceIndicator(lifecycle, midiLearning, parameter, element, target, indicatorOffset)
    lifecycle.own(attachParameterContextMenu(editing, midiLearning, tracks, parameter, target, disableAutomation))
    return element
}
