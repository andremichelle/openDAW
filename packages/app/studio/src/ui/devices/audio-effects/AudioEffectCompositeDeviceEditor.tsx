import css from "./AudioEffectCompositeDeviceEditor.sass?inline"
import {AudioCompositeAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {MenuButton} from "@/ui/components/MenuButton"
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
    // The Add Effect footer: a menu of every audio effect (each appends a new branch holding it), which also
    // takes an effect dragged onto it. A fixed split owns its branches by index, so it gets no footer.
    const footer: Option<HTMLElement> = adapter.entriesFixed ? Option.None : Option.wrap(
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent
            .addMenuItem(...EffectFactories.AudioList.map(factory => MenuItem.default({
                label: factory.defaultName, icon: factory.defaultIcon, separatorBefore: factory.separatorBefore
            }).setTriggerProcedure(() =>
                AudioCompositeEntryDnD.insertBranch(project, adapter, adapter.entries.adapters().length, factory)))))}
                    appearance={{framed: true, tooltip: "Add a parallel effect branch"}}
                    stretch={true}
                    onInit={button => lifecycle.own(AudioCompositeEntryDnD.installAppendTarget({
                        element: button, project, composite: adapter
                    }))}>
            <span className="add-effect">+ Add Effect</span>
        </MenuButton>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <CompositeEntryList lifecycle={lifecycle}
                                                  rows={rows}
                                                  watch={update => adapter.entries.subscribe({
                                                      onAdd: update, onRemove: update, onReorder: update
                                                  })}
                                                  footer={footer}/>
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
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={icon}/>
    )
}