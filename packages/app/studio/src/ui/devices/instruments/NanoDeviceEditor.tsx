import css from "./NanoDeviceEditor.sass?inline"
import {asInstanceOf, Lifecycle, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceHost, InstrumentFactories, NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {StudioService} from "@/service/StudioService"
import {paintWaveform} from "./NanoDeviceEditor/WaveformPainter"
import {attachMarkerDragging} from "./NanoDeviceEditor/MarkerDragging"
import {subscribePlayheads} from "./NanoDeviceEditor/PlayheadPainter"
import {ControlContext, createParameterRow, createParameterStack} from "./NanoDeviceEditor/ParameterControls"

const className = Html.adoptStyleSheet(css, "NanoDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NanoDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const NanoDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        volume,
        octave,
        attack,
        release,
        sampleStart,
        sampleEnd,
        rootKey,
        loop,
        loopFade,
        loopStart,
        loopEnd,
        tune
    } = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver} = project
    const fileNameLabel: HTMLElement = (<span className="file-name"/>)
    const dropHint: HTMLElement = (
        <div className="drop-hint">
            <Icon symbol={IconSymbol.Waveform}/>
            <span>drop audio here</span>
        </div>
    )
    const waveformCanvas: HTMLCanvasElement = (<canvas/>)
    const playbackCanvas: HTMLCanvasElement = (<canvas style={{pointerEvents: "none"}}/>)
    const display: HTMLElement = (
        <div className="display">
            {waveformCanvas}
            {playbackCanvas}
            {dropHint}
            {fileNameLabel}
        </div>
    )
    const waveformPainter = new CanvasPainter(waveformCanvas, painter => paintWaveform(painter, adapter))
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forDeviceFile(adapter.box.file))
    const loaderTerminator = new Terminator()
    const controls: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    lifecycle.ownAll(
        loaderTerminator,
        waveformPainter,
        sampleSelector.configureDrop(display),
        sampleSelector.configureBrowseClick(dropHint),
        sampleSelector.configureContextMenu(waveformCanvas),
        adapter.box.file.catchupAndSubscribe(pointer => {
            loaderTerminator.terminate()
            pointer.targetVertex.match({
                none: () => {
                    dropHint.classList.remove("hidden")
                    fileNameLabel.textContent = ""
                },
                some: ({box}) => {
                    dropHint.classList.add("hidden")
                    fileNameLabel.textContent = asInstanceOf(box, AudioFileBox).fileName.getValue()
                }
            })
            waveformPainter.requestUpdate()
            loaderTerminator.own(adapter.file().match({
                none: () => Terminable.Empty,
                some: file => file.getOrCreateLoader().subscribe(state => {
                    if (state.type === "loaded") {
                        fileNameLabel.textContent = file.box.fileName.getValue()
                        waveformPainter.requestUpdate()
                    } else if (state.type === "progress") {
                        fileNameLabel.textContent = `Loading... (${Math.round(state.progress * 100.0)}%)`
                    } else if (state.type === "error") {
                        fileNameLabel.textContent = state.reason
                    }
                })
            }))
        }),
        sampleStart.subscribe(waveformPainter.requestUpdate),
        sampleEnd.subscribe(waveformPainter.requestUpdate),
        loop.subscribe(waveformPainter.requestUpdate),
        loopStart.subscribe(waveformPainter.requestUpdate),
        loopEnd.subscribe(waveformPainter.requestUpdate),
        loopFade.subscribe(waveformPainter.requestUpdate),
        attachMarkerDragging(waveformCanvas, editing, adapter),
        subscribePlayheads(liveStreamReceiver, adapter, playbackCanvas)
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Reverse", separatorBefore: true})
                              .setTriggerProcedure(() => editing.modify(() => {
                                  const start = sampleStart.getValue()
                                  sampleStart.setValue(sampleEnd.getValue())
                                  sampleEnd.setValue(start)
                              })))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              {display}
                              {createParameterStack(controls, "main", "Main", rootKey, volume)}
                              {createParameterStack(controls, "pitch", "Pitch", tune, octave)}
                              {createParameterStack(controls, "envelope", "Envelope", attack, release)}
                              {createParameterStack(controls, "waveform", "Waveform", sampleStart, sampleEnd)}
                              <div className="parameter-stack wide loop">
                                  <div className="label">Loop</div>
                                  {createParameterRow(controls, loopStart, "Start")}
                                  {createParameterRow(controls, loopFade, "Fade", true)}
                                  {createParameterRow(controls, loopEnd, "End")}
                                  <div className="name second">On</div>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={loop}>
                                      <Checkbox lifecycle={lifecycle}
                                                model={EditWrapper.forAutomatableParameter(editing, loop)}
                                                className="toggle"
                                                appearance={{activeColor: Colors.green}}>
                                          <Icon symbol={IconSymbol.Checkbox}/>
                                      </Checkbox>
                                  </AutomationControl>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Nano.defaultIcon}/>
    )
}
