import css from "./HeadersArea.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {Html} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop.ts"
import {AnyDragData} from "@/ui/AnyDragData"

const className = Html.adoptStyleSheet(css, "HeaderArea")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    scrollModel: ScrollModel
}

export const HeadersArea = ({lifecycle, service, scrollModel}: Construct) => {
    const {project} = service
    const {} = project
    const element: HTMLElement = (<div className={className} tabIndex={-1}/>)

    lifecycle.ownAll(
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                console.debug(event, data)
                return data.type === "instrument" || data.type === "sample"
            },
            drop: (_event: DragEvent, data: AnyDragData) => {
                console.debug("drop", data)
            },
            enter: (_allowDrop: boolean) => {},
            leave: () => {}
        }),
        installAutoScroll(element, (_deltaX, deltaY) => {if (deltaY !== 0) {scrollModel.moveBy(deltaY)}})
    )
    return element
}