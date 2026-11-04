import css from "./ZeitgeistDeviceEditor.sass?inline"
import {DeviceHost, Grooves, ZeitgeistDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {GrooveEditor} from "@/ui/grooves/GrooveEditor"

const className = Html.adoptStyleSheet(css, "ZeitgeistDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ZeitgeistDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ZeitgeistDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {liveStreamReceiver, rootBoxAdapter} = project
    const pointer = adapter.box.groove
    const host: HTMLElement = <div className={className}/>
    const contents = lifecycle.own(new Terminator())
    const render = () => {
        contents.terminate()
        Html.empty(host)
        host.append(GrooveEditor({
            lifecycle: contents,
            service,
            groove: pointer.targetVertex.mapOr(vertex =>
                Grooves.adapterOf(project, Grooves.asGrooveBox(vertex.box)), null),
            pointer
        }))
    }
    lifecycle.ownAll(
        pointer.subscribe(() => render()),
        rootBoxAdapter.grooves.subscribe({onAdd: () => render(), onRemove: () => render(), onReorder: () => {}}))
    render()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => host}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.Zeitgeist.defaultIcon}/>
    )
}
