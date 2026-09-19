import css from "../audio-effects/AudioEffectCompositeDeviceEditor.sass?inline"
import {DeviceHost, InstrumentCompositeBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CompositeEntryList} from "@/ui/devices/CompositeEntryList"
import {InstrumentCompositeLayer} from "@/ui/devices/InstrumentCompositeLayer"
import {AddLayerButton} from "@/ui/devices/AddLayerButton"
import {InstrumentCompositeLayerDnD} from "@/ui/devices/InstrumentCompositeLayerDnD"
import {StudioService} from "@/service/StudioService"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "AudioEffectCompositeDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: InstrumentCompositeBoxAdapter
    deviceHost: DeviceHost
}

export const InstrumentCompositeDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, api} = project
    const rows = (rowLifecycle: Lifecycle): ReadonlyArray<Element> => adapter.cells.adapters()
        .map(layer => <InstrumentCompositeLayer lifecycle={rowLifecycle} service={service} layer={layer}/>)
    const footer: Option<HTMLElement> = Option.wrap(
        <AddLayerButton select={factory => editing.modify(() => {
            const attempt = api.createCompositeLayer(adapter.box, factory)
            if (attempt.isFailure()) {console.debug(attempt.failureReason())}
        })} onInit={button => lifecycle.own(InstrumentCompositeLayerDnD.installAppendTarget({
            element: button, project, composite: adapter
        }))}/>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => {
                          const list: HTMLElement = (
                              <CompositeEntryList lifecycle={lifecycle}
                                                  rows={rows}
                                                  watch={update => adapter.cells.subscribe({
                                                      onAdd: update, onRemove: update, onReorder: update
                                                  })}
                                                  footer={footer}/>
                          )
                          lifecycle.own(InstrumentCompositeLayerDnD.installAppendTarget({
                              element: list, project, composite: adapter,
                              active: () => adapter.cells.adapters().length === 0
                          }))
                          return <div className={className}>{list}</div>
                      }}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.Stack}/>
    )
}
