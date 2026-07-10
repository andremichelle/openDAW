import css from "./ReSoulDeviceEditor.sass?inline"
import {asDefined, asInstanceOf, clamp, Lifecycle, Option, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Html} from "@opendaw/lib-dom"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceHost, InstrumentFactories, ReSoulDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {SnapValueThresholdInPixels} from "@/ui/timeline/editors/value/ValueMoveModifier"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "ReSoulDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ReSoulDeviceBoxAdapter
    deviceHost: DeviceHost
}

const paintWaveform = ({context, width, height}: CanvasPainter, adapter: ReSoulDeviceBoxAdapter): void =>
    adapter.file().match({
        none: () => context.clearRect(0, 0, width, height),
        some: file => {
            context.clearRect(0, 0, width, height)
            file.getOrCreateLoader().peaks.ifSome(peaks => {
                const {numFrames, numChannels} = peaks
                const {sampleStart, sampleEnd} = adapter.namedParameter
                const wd = (width - 1) * devicePixelRatio
                const s0 = Math.min(sampleStart.getValue(), sampleEnd.getValue())
                const s1 = Math.max(sampleStart.getValue(), sampleEnd.getValue())
                const u0 = s0 * numFrames
                const u1 = s1 * numFrames
                const x0 = s0 * wd
                const x1 = s1 * wd
                const rowHeight = height * devicePixelRatio / numChannels
                const layout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
                const renderRange = (from: number, to: number, xFrom: number, xTo: number) => {
                    for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                        layout.u0 = from
                        layout.u1 = to
                        layout.x0 = xFrom
                        layout.x1 = xTo
                        layout.y0 = rowHeight * channelIndex
                        layout.y1 = rowHeight * (channelIndex + 1)
                        PeaksPainter.renderPixelStrips(context, peaks, channelIndex, layout)
                    }
                }
                context.fillStyle = Colors.bright.toString()
                renderRange(u0, u1, x0, x1)
                context.fillRect(Math.round(x0), 0, 1, height * devicePixelRatio)
                context.fillRect(Math.round(x1), 0, 1, height * devicePixelRatio)
                context.globalAlpha = 0.25
                if (u0 > 0.0) {renderRange(0.0, u0, 0.0, x0)}
                if (u1 < numFrames) {renderRange(u1, numFrames, x1, wd)}
                context.globalAlpha = 1.0
            })
        }
    })

export const ReSoulDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {volume, octave, reverse, attack, release, sampleStart, sampleEnd, rootKey} = adapter.namedParameter
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
    const playbackContext: CanvasRenderingContext2D = asDefined(playbackCanvas.getContext("2d"))
    const waveformPainter = new CanvasPainter(waveformCanvas, painter => paintWaveform(painter, adapter))
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forPointerField(adapter.box.file))
    let loaderSubscription: Terminable = Terminable.Empty
    lifecycle.ownAll(
        Terminable.create(() => loaderSubscription.terminate()),
        waveformPainter,
        sampleSelector.configureDrop(waveformCanvas),
        sampleSelector.configureBrowseClick(dropHint),
        sampleSelector.configureContextMenu(waveformCanvas),
        adapter.box.file.catchupAndSubscribe(pointer => {
            loaderSubscription.terminate()
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
            loaderSubscription = adapter.file().match({
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
            })
        }),
        sampleStart.subscribe(waveformPainter.requestUpdate),
        sampleEnd.subscribe(waveformPainter.requestUpdate),
        Dragging.attach(waveformCanvas, ({clientX}: PointerEvent) => {
            const {left, width} = waveformCanvas.getBoundingClientRect()
            const dl = clientX - (left + sampleStart.getValue() * width)
            const dr = clientX - (left + sampleEnd.getValue() * width)
            let min = SnapValueThresholdInPixels
            let dir = 0
            if (min > Math.abs(dl)) {
                min = dl
                dir = -1
            }
            if (Math.abs(min) > Math.abs(dr)) {
                min = Math.abs(dr)
                dir = 1
            }
            if (dir === 0) {return Option.None}
            return Option.wrap({
                update: ({clientX}: Dragging.Event): void => {
                    const {left, width} = waveformCanvas.getBoundingClientRect()
                    const ratio = clamp((clientX - min - left) / width, 0.0, 1.0)
                    editing.modify(() => {
                        if (dir === -1) {
                            sampleStart.setValue(ratio)
                        } else {
                            sampleEnd.setValue(ratio)
                        }
                    }, false)
                },
                cancel: () => editing.revertPending(),
                approve: () => editing.mark()
            } satisfies Dragging.Process)
        }),
        liveStreamReceiver.subscribeFloats(adapter.positionsAddress, array => {
            const {canvas} = playbackContext
            adapter.file().flatMap(file => file.data).match({
                none: () => {
                    canvas.width = canvas.clientWidth
                    canvas.height = canvas.clientHeight
                },
                some: data => {
                    canvas.width = canvas.clientWidth
                    canvas.height = canvas.clientHeight
                    playbackContext.fillStyle = Colors.blue.toString()
                    for (const position of array) {
                        if (position === -1) {break}
                        const x = position / data.numberOfFrames * canvas.width
                        playbackContext.fillRect(x, 0, 1, canvas.height)
                    }
                }
            })
        })
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="display">
                                  <div className="waveform">
                                      {waveformCanvas}
                                      {playbackCanvas}
                                      {dropHint}
                                      {fileNameLabel}
                                  </div>
                              </div>
                              <div className="controls">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: attack
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: release
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: sampleStart, label: "start"
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: sampleEnd, label: "end"
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: rootKey, anchor: 60 / 127
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: octave, anchor: 0.5
                                  })}
                                  <div className="reverse">
                                      <div className="label">reverse</div>
                                      <AutomationControl lifecycle={lifecycle}
                                                         editing={editing}
                                                         midiLearning={midiLearning}
                                                         tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                         parameter={reverse}>
                                          <Checkbox lifecycle={lifecycle}
                                                    model={EditWrapper.forAutomatableParameter(editing, reverse)}
                                                    appearance={{activeColor: Colors.orange, framed: true}}>
                                              <Icon symbol={IconSymbol.Swap}/>
                                          </Checkbox>
                                      </AutomationControl>
                                  </div>
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: volume
                                  })}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.ReSoul.defaultIcon}/>
    )
}
