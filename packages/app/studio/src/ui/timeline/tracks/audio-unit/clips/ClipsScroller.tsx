import css from "./ClipsScroller.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Orientation, Scroller} from "@/ui/components/Scroller"
import {ScrollModel} from "@/ui/components/ScrollModel"
import {ClipWidth} from "./constants"

const className = Html.adoptStyleSheet(css, "ClipsScroller")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ClipsScroller = ({lifecycle, service}: Construct) => {
    const {clips} = service.timeline
    const model = lifecycle.own(new ScrollModel())
    const element: HTMLElement = (
        <div className={className}>
            <Scroller lifecycle={lifecycle} model={model} orientation={Orientation.horizontal}/>
        </div>
    )
    const updateSizes = () => {
        model.visibleSize = element.clientWidth
        model.contentSize = Math.max(clips.columns.getValue(), clips.count.getValue()) * ClipWidth
        model.position = clips.scroll.getValue()
    }
    lifecycle.ownAll(
        Html.watchResize(element, updateSizes),
        clips.columns.subscribe(updateSizes),
        clips.count.subscribe(updateSizes),
        clips.scroll.subscribe(owner => model.position = owner.getValue()),
        model.subscribe(() => {
            if (model.position !== Math.round(clips.scroll.getValue())) {clips.scroll.setValue(model.position)}
        })
    )
    updateSizes()
    return element
}
