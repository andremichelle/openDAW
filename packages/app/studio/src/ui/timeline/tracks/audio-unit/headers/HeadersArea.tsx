import css from "./HeadersArea.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {Html} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop.ts"
import {AnyDragData} from "@/ui/AnyDragData"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager"

const className = Html.adoptStyleSheet(css, "HeaderArea")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    manager: TracksManager
    scrollModel: ScrollModel
}

export const HeadersArea = ({lifecycle, service, scrollModel}: Construct) => (
    <div className={className}
         tabIndex={-1}
         onInit={element => {
             const {project} = service
             const {api, editing} = project
             lifecycle.ownAll(
                 DragAndDrop.installTarget(element, {
                     drag: (_event: DragEvent, data: AnyDragData): boolean => data.type === "instrument",
                     drop: (_event: DragEvent, data: AnyDragData) => {
                         if (data.type === "instrument") {
                             const factory = InstrumentFactories[data.device]
                             editing.modify(() => DefaultInstrumentFactory.create(api, factory))
                         }
                     },
                     enter: (_allowDrop: boolean) => {},
                     leave: () => {}
                 }),
                 installAutoScroll(element, (_deltaX, deltaY) => {if (deltaY !== 0) {scrollModel.moveBy(deltaY)}})
             )
         }}/>
)