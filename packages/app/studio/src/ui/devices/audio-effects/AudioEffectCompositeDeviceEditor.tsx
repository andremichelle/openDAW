import css from "./AudioEffectCompositeDeviceEditor.sass?inline"
import {AudioCompositeAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {AddEffectButton} from "@/ui/devices/AddEffectButton"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {SnapCommonDecibel} from "@/ui/configs.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CompositeEntryList} from "@/ui/devices/CompositeEntryList"
import {AudioCompositeEntry} from "@/ui/devices/AudioCompositeEntry"
import {AudioCompositeEntryDnD} from "@/ui/devices/AudioCompositeEntryDnD"
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
    const footer: Option<HTMLElement> = adapter.entriesFixed ? Option.None : Option.wrap(
        <AddEffectButton
            select={factory => AudioCompositeEntryDnD.insertBranch(project, adapter, adapter.entries.adapters().length, factory)}
            onInit={button => lifecycle.own(AudioCompositeEntryDnD.installAppendTarget({
                element: button, project, composite: adapter
            }))}/>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => {
                          const list: HTMLElement = (
                              <CompositeEntryList lifecycle={lifecycle}
                                                  rows={rows}
                                                  watch={update => adapter.entries.subscribe({
                                                      onAdd: update, onRemove: update, onReorder: update
                                                  })}
                                                  footer={footer}/>
                          )
                          if (!adapter.entriesFixed) {
                              // With no branches there are no per-row targets, so let the WHOLE list body accept a
                              // drop (dropping on the tiny + button is tedious); once a branch exists the rows take over.
                              lifecycle.own(AudioCompositeEntryDnD.installAppendTarget({
                                  element: list, project, composite: adapter,
                                  active: () => adapter.entries.adapters().length === 0
                              }))
                          }
                          return (
                          <div className={className}>
                              {list}
                              <div className="mix">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter,
                                      parameter: adapter.namedParameter.dry, options: SnapCommonDecibel
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter,
                                      parameter: adapter.namedParameter.wet, options: SnapCommonDecibel
                                  })}
                                  <div/>
                              </div>
                          </div>)
                      }}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={icon}/>
    )
}