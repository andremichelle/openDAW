import css from "./AudioBusEditor.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {AudioBusBoxAdapter} from "@moises-ai/studio-adapters"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "Editor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AudioBusBoxAdapter
}

export const AudioBusEditor = ({lifecycle, service, adapter}: Construct) => {
    const {project} = service
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, adapter.deviceHost())}
                      populateControls={() => false}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.Merge}>
            <div className={className}>
                <span>audio-bus</span>
            </div>
        </DeviceEditor>
    )
}