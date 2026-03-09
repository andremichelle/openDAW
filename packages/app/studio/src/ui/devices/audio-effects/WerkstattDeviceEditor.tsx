import css from "./WerkstattDeviceEditor.sass?inline"
import defaultCode from "./werkstatt-default.txt?raw"
import {DeviceHost, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {WerkstattCompiler} from "./WerkstattCompiler"

const className = Html.adoptStyleSheet(css, "WerkstattDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WerkstattDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const WerkstattDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? WerkstattCompiler.stripHeader(storedCode) : defaultCode
    const textarea = <textarea spellcheck={false}>{userCode}</textarea> as HTMLTextAreaElement
    const runButton = <button onclick={async () => {
        await WerkstattCompiler.compile(service.audioContext, box, textarea.value)
    }}>Run</button>
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {textarea}
                              {runButton}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Werkstatt.defaultIcon}/>
    )
}
