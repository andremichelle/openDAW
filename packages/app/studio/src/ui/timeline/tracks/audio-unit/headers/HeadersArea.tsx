import css from "./HeadersArea.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {Html} from "@opendaw/lib-dom"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager"
import {Config} from "@/ui/timeline/Config"

const className = Html.adoptStyleSheet(css, "HeaderArea")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    manager: TracksManager
    scrollModel: ScrollModel
}

export const HeadersArea = ({lifecycle, scrollModel}: Construct) => (
    <div className={className}
         tabIndex={-1}
         onInit={element => lifecycle.own(
             installAutoScroll(element, (_deltaX, deltaY) => {if (deltaY !== 0) {scrollModel.moveBy(deltaY)}},
                 {dragPadding: Config.AutoScrollDragPaddingVertical}))}/>
)
