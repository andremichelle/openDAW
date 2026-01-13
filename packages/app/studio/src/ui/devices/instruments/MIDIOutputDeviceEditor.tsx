import css from "./MIDIOutputDeviceEditor.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceHost, InstrumentFactories, MIDIOutputDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {StudioService} from "@/service/StudioService"
import {DeviceSelector} from "@/ui/devices/instruments/MIDIOutputEditor/DeviceSelector"
import {ControlValues} from "@/ui/devices/instruments/MIDIOutputEditor/ControlValues"
import {DeviceParameters} from "@/ui/devices/instruments/MIDIOutputEditor/DeviceParameters"
import {AddParameterButton} from "@/ui/devices/instruments/MIDIOutputEditor/AddParameterButton"

const className = Html.adoptStyleSheet(css, "editor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: MIDIOutputDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const MIDIOutputDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <DeviceSelector lifecycle={lifecycle}
                                              project={project}
                                              adapter={adapter}/>
                              <hr/>
                              <DeviceParameters lifecycle={lifecycle}
                                                editing={editing}
                                                box={adapter.box}/>
                              <ControlValues lifecycle={lifecycle}
                                             project={project}
                                             adapter={adapter}/>
                              <AddParameterButton project={project} adapter={adapter}/>
                          </div>
                      )}
                      populateMeter={() => false}
                      icon={InstrumentFactories.MIDIOutput.defaultIcon}/>
    )
}