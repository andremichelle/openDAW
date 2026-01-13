import css from "./PlayfieldSampleEditor.sass?inline"
import {Lifecycle, Terminable} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Events, Html} from "@moises-ai/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, InstrumentFactories, NoteLifeCycle, PlayfieldSampleBoxAdapter} from "@moises-ai/studio-adapters"
import {SlotEditor} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotEditor"
import {Icon} from "@/ui/components/Icon"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "PlayfieldSampleEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldSampleBoxAdapter
    deviceHost: DeviceHost
}

export const PlayfieldSampleEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {engine, liveStreamReceiver, userEditingManager} = project
    const audioUnitBoxAdapter = deviceHost.audioUnitBoxAdapter()
    const fileName = adapter.file().mapOr(file => file.box.fileName.getValue(), "N/A")
    const deviceName = adapter.device().labelField.getValue()
    const goDevice = () => userEditingManager.audioUnit.edit(deviceHost.audioUnitBoxAdapter().box.editing)
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <SlotEditor lifecycle={lifecycle}
                                      service={service}
                                      adapter={adapter}/>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.peakAddress}/>
                      )}
                      createLabel={() => {
                          const deviceLabel: HTMLElement = (
                              <span className="device-name"
                                    onclick={goDevice}
                                    style={{backgroundColor: Colors.green.toString()}}>
                                  {deviceName}
                              </span>
                          )
                          const playLabel: HTMLElement = (
                              <span className="play-label">
                                  <Icon symbol={IconSymbol.Play}/> {fileName}
                              </span>
                          )
                          let noteLifeTime = Terminable.Empty
                          lifecycle.ownAll(
                              Terminable.create(() => noteLifeTime.terminate()),
                              TextTooltip.default(deviceLabel, () => "Go back to device"),
                              TextTooltip.default(playLabel, () => "Play sample"),
                              Events.subscribe(playLabel, "dblclick", event => event.stopPropagation()),
                              Events.subscribe(playLabel, "pointerdown", (event: PointerEvent) => {
                                  event.stopPropagation()
                                  playLabel.setPointerCapture(event.pointerId)
                                  noteLifeTime = NoteLifeCycle.start(signal => engine.noteSignal(signal), audioUnitBoxAdapter.uuid, adapter.indexField.getValue())
                              }),
                              Events.subscribe(playLabel, "pointerup", () => noteLifeTime.terminate())
                          )
                          return (
                              <h1 className="playfield-sample-label">
                                  {deviceLabel} {playLabel}
                              </h1>
                          )
                      }}
                      icon={InstrumentFactories.Playfield.defaultIcon}
                      className={className}/>
    )
}