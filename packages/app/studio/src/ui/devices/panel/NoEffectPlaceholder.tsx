import css from "./NoEffectPlaceholder.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, Devices} from "@opendaw/studio-adapters"
import {EffectFactory} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {AddEffectButton} from "@/ui/devices/AddEffectButton"

const className = Html.adoptStyleSheet(css, "NoEffectPlaceholder")

type Construct = {
    service: StudioService
}

export const NoEffectPlaceholder = ({service}: Construct) => {
    const {project} = service
    const addEffect = (factory: EffectFactory): void => {
        const optEditing = project.userEditingManager.audioUnit.get()
        if (optEditing.isEmpty()) {return}
        const host = project.boxAdapters.adapterFor(optEditing.unwrap().box, Devices.isHost)
        DeviceHost.chainFieldOf(host, "audio").ifSome(field =>
            project.editing.modify(() => project.api.insertEffect(field, factory)))
    }
    return (
        <div className={className}>
            <AddEffectButton select={addEffect}/>
        </div>
    )
}
