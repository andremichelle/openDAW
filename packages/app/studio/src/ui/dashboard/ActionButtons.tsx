import css from "./ActionButtons.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {StudioService} from "@/service/StudioService"
import {connectRoom} from "@/service/StudioLiveRoomConnect"

const className = Html.adoptStyleSheet(css, "ActionButtons")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ActionButtons = ({service}: Construct) => (
    <div className={className}>
        <button className="action" onclick={() => service.newProject()}>
            <Icon symbol={IconSymbol.New}/>
            <div className="text">
                <div className="title">New Project</div>
                <div className="desc">Empty timeline, start from a clean slate.</div>
            </div>
        </button>
        <button className="action" onclick={() => connectRoom(service)}>
            <Icon symbol={IconSymbol.Connected}/>
            <div className="text">
                <div className="title">New Live Room</div>
                <div className="desc">Jam with others in real time, share a link.</div>
            </div>
        </button>
        <button className="action muted" onclick={() => service.importBundle()}>
            <Icon symbol={IconSymbol.Folder}/>
            <div className="text">
                <div className="title">Open Bundle</div>
                <div className="desc">Load a project bundle (.odb) from disk.</div>
            </div>
        </button>
    </div>
)
