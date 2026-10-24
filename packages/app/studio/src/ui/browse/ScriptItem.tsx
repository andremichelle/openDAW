import css from "./ScriptItem.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {CommunityScript} from "@/opendaw-api/CommunityIndex"
import {DeviceIcon, StockDeviceMeta} from "@/ui/browse/DeviceItem"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {DragScript} from "@/ui/AnyDragData"

const className = Html.adoptStyleSheet(css, "ScriptItem")

type Construct = {
    service: StudioService
    script: CommunityScript
    device: StockDeviceMeta
    lifecycle: Lifecycle
}

export const ScriptItem = ({service, script, device, lifecycle}: Construct): HTMLElement => {
    const item: HTMLElement = (
        <div className={className}>
            <DeviceIcon device={device}/>
            <span className="name">{script.name}</span>
            <span className="brief">{script.description}</span>
        </div>
    )
    lifecycle.ownAll(
        Events.subscribe(item, "dblclick", () => SpotlightCreate.script(service, script)),
        DragAndDrop.installSource(item, () => ({type: "script", script} satisfies DragScript))
    )
    return item
}
