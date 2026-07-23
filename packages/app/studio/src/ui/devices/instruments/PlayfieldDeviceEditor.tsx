import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, InstrumentFactories, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {SlotGrid} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotGrid"
import {ChopTrigger} from "@/ui/devices/instruments/PlayfieldDeviceEditor/ChopTrigger"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    deviceHost: DeviceHost
}

const octave = new DefaultObservableValue(5) // TODO Make that bound to its PlayfieldDeviceBoxAdapter

export const PlayfieldDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          parent.addMenuItem(MenuItem.default({label: "Reset All"})
                              .setTriggerProcedure(() => project.editing.modify(() => adapter.reset())))
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                      }}
                      populateControls={() => {
                          const container: HTMLElement = (
                              <div className="playfield-drop" style={{display: "contents"}}>
                                  <SlotGrid lifecycle={lifecycle}
                                            service={service}
                                            adapter={adapter}
                                            octave={octave}/>
                              </div>
                          )
                          const overSlot = (event: DragEvent): boolean =>
                              isDefined((event.target as HTMLElement)?.closest?.("[data-slot-index]"))
                          lifecycle.own(DragAndDrop.installTarget(container, {
                              drag: (event, data) =>
                                  (data.type === "sample" || data.type === "file") && !overSlot(event),
                              drop: async (_event, data) => {
                                  const sample = await ChopTrigger.resolveSample(service, data)
                                  sample.ifSome(sample =>
                                      ChopTrigger.forSample(service, adapter, sample, ChopTrigger.DEFAULT_START_KEY))
                              },
                              enter: allow => container.classList.toggle("accept", allow),
                              leave: () => container.classList.remove("accept")
                          }))
                          return container
                      }}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Playfield.defaultIcon}/>
    )
}