import css from "./PanelResizer.sass?inline"
import {clamp, isDefined, Lifecycle, Option} from "@moises-ai/lib-std"
import {Dragging, Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {ContentGlue} from "@/ui/workspace/ContentGlue.ts"
import {AxisProperty} from "@/ui/workspace/AxisProperty.ts"
import {PanelContents} from "@/ui/workspace/PanelContents.tsx"

const className = Html.adoptStyleSheet(css, "PanelResizer")

type Construct = {
    lifecycle: Lifecycle
    orientation: Workspace.Orientation
    siblings: ReadonlyArray<ContentGlue>
    panelContents: PanelContents
    target: Element
}

export const PanelResizer = ({lifecycle, orientation, siblings, panelContents, target}: Construct) => {
    const element: HTMLElement = <div className={Html.buildClassList(className, orientation)}/>
    const direction = AxisProperty[orientation]
    lifecycle.own(Dragging.attach(element, (beginEvent) => {
        const successor = element.nextElementSibling
        if (successor === null) {return Option.None}
        const parent = element.parentElement
        if (parent === null) {return Option.None}
        const elements = siblings
            .map(({content, element}) => {
                return {
                    content: content,
                    element: element,
                    size: element[direction.size],
                    style: element.style
                }
            })
        const curr = elements.find(({element}) => element === target)
        const next = elements.find(({element}) => element === successor)
        if (!isDefined(curr) || !isDefined(next)) {return Option.None}
        if (panelContents.isClosed(curr.content) || panelContents.isClosed(next.content)) {return Option.None}
        const currConstrains = curr.content.constrains
        const nextConstrains = next.content.constrains
        if (currConstrains.type === "fixed" || nextConstrains.type === "fixed") {return Option.None}
        const beginPointer = beginEvent[direction.pointer]
        const beginSizeA = curr.size
        const beginSizeB = next.size
        const sumSize = curr.size + next.size
        const sumFlex = currConstrains.flex + nextConstrains.flex
        return Option.wrap({
            update: (event: Dragging.Event): void => {
                const minSizeA = currConstrains.minSize
                const minSizeB = nextConstrains.minSize
                const maxSizeA = currConstrains.maxSize ?? Number.MAX_SAFE_INTEGER
                const maxSizeB = nextConstrains.maxSize ?? Number.MAX_SAFE_INTEGER
                const delta = event[direction.pointer] - beginPointer
                const sizeA = clamp(beginSizeA + delta, Math.max(minSizeA, sumSize - maxSizeB), Math.min(maxSizeA, sumSize - minSizeB))
                const sizeB = clamp(beginSizeB - delta, Math.max(minSizeB, sumSize - maxSizeA), Math.min(maxSizeB, sumSize - minSizeA))
                const flexA = sizeA / sumSize * sumFlex
                const flexB = sizeB / sumSize * sumFlex
                currConstrains.flex = flexA
                nextConstrains.flex = flexB
                curr.style.flexGrow = flexA.toString()
                next.style.flexGrow = flexB.toString()
            }
        })
    }))
    return element
}