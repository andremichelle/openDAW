import css from "./AudioEffectCompositeDeviceEditor.sass?inline"
import {AudioCompositeAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioEffectCompositeCellBox} from "@opendaw/studio-boxes"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CompositeEntryList} from "@/ui/devices/CompositeEntryList"
import {AudioCompositeEntry} from "@/ui/devices/AudioCompositeEntry"
import {StudioService} from "@/service/StudioService"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "AudioEffectCompositeDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AudioCompositeAdapter
    deviceHost: DeviceHost
    icon: IconSymbol
}

export const AudioEffectCompositeDeviceEditor = ({lifecycle, service, adapter, deviceHost, icon}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const rows = (rowLifecycle: Lifecycle): ReadonlyArray<Element> => adapter.entries.adapters()
        .map(entry => (
            <AudioCompositeEntry lifecycle={rowLifecycle}
                                 service={service}
                                 entry={entry}
                                 fixed={adapter.entriesFixed}/>
        ))
    const addEntry = () => editing.modify(() =>
        AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
            box.composite.refer(adapter.box.entries)
            box.index.setValue(adapter.entries.adapters().length)
        }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="mix">
                                  {Object.values(adapter.namedParameter)
                                      .map(parameter => ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter
                                      }))}
                              </div>
                              <CompositeEntryList lifecycle={lifecycle}
                                                  rows={rows}
                                                  watch={update => adapter.entries.subscribe({
                                                      onAdd: update, onRemove: update, onReorder: update
                                                  })}
                                                  fixed={adapter.entriesFixed}
                                                  addEntry={addEntry}/>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={icon}/>
    )
}