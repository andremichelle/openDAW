import css from "./ActionButtons.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {EmptyExec, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {StudioService} from "@/service/StudioService"
import {connectRoom} from "@/service/StudioLiveRoomConnect"
import {NeuralDemux} from "@/service/NeuralDemux.tsx"

const className = Html.adoptStyleSheet(css, "ActionButtons")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ActionButtons = ({service}: Construct) => (
    <div className={className}>
        <button className="action" title="Empty timeline, start from a clean slate."
                onclick={() => service.newProject()}>
            <Icon symbol={IconSymbol.New}/><span>New Project</span>
        </button>
        <button className="action" title="Jam with others in real time, share a link."
                onclick={() => connectRoom(service)}>
            <Icon symbol={IconSymbol.Connected}/><span>New Live Room</span>
        </button>
        <button className="action" title="Load a project bundle (.odb) from disk."
                onclick={() => service.importBundle()}>
            <Icon symbol={IconSymbol.Folder}/><span>Open Bundle</span>
        </button>
        <button className="action" title="Split a music file into drums, bass, vocals and other."
                onclick={() => NeuralDemux.explain(service).catch(EmptyExec)}>
            <Icon symbol={IconSymbol.Robot}/><span>Neural Demux</span>
        </button>
    </div>
)
