import css from "./NanoDeviceEditor.sass?inline"
import {asDefined, asInstanceOf, clamp, isDefined, Lifecycle, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Html} from "@opendaw/lib-dom"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {AutomatableParameterFieldAdapter, DeviceHost, InstrumentFactories, NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {SnapValueThresholdInPixels} from "@/ui/timeline/editors/value/ValueMoveModifier"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NanoDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NanoDeviceBoxAdapter
    deviceHost: DeviceHost
}

const paintWaveform = ({context, width, height}: CanvasPainter, adapter: NanoDeviceBoxAdapter): void =>
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
                const {loop, loopStart, loopEnd, loopFade} = adapter.namedParameter
                if (loop.getValue()) {
                    const fullHeight = height * devicePixelRatio
                    const l0 = Math.max(Math.min(loopStart.getValue(), loopEnd.getValue()), s0)
                    const l1 = Math.min(Math.max(loopStart.getValue(), loopEnd.getValue()), s1)
                    const [lo, hi] = (l1 - l0) * numFrames < 1.0 ? [s0, s1] : [l0, l1]
                    const fade = file.getOrCreateLoader().data
                        .map(data => Math.min(loopFade.getValue() * data.sampleRate / numFrames, (hi - lo) * 0.5))
                        .unwrapOrElse(0.0)
                    context.fillStyle = Colors.green.toString()
                    context.globalAlpha = 0.2
                    context.fillRect(Math.round(lo * wd), 0, Math.round(fade * wd), fullHeight)
                    context.fillRect(Math.round((hi - fade) * wd), 0, Math.round(fade * wd), fullHeight)
                    context.globalAlpha = 1.0
                    context.fillRect(Math.round(lo * wd), 0, 1, fullHeight)
                    context.fillRect(Math.round(hi * wd), 0, 1, fullHeight)
                }
            })
        }
    })

export const NanoDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {volume, octave, attack, release, sampleStart, sampleEnd, rootKey, loop, loopFade, loopStart, loopEnd} = adapter.namedParameter
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
    const playbackContext: CanvasRenderingContext2D = asDefined(playbackCanvas.getContext("2d"))
    const waveformPainter = new CanvasPainter(waveformCanvas, painter => paintWaveform(painter, adapter))
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forDeviceFile(adapter.box.file))
    const loaderTerminator = new Terminator()
    const createParameterInput = (parameter: AutomatableParameterFieldAdapter) => (
        <AutomationControl lifecycle={lifecycle}
                           editing={editing}
                           midiLearning={midiLearning}
                           tracks={deviceHost.audioUnitBoxAdapter().tracks}
                           parameter={parameter}>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}>
                <ParameterLabel lifecycle={lifecycle}
                                parameter={parameter}
                                framed/>
            </RelativeUnitValueDragging>
        </AutomationControl>
    )
    const createParameterRow = (parameter: AutomatableParameterFieldAdapter, name?: string, second?: boolean) => [
        <div className={Html.buildClassList("name", second && "second")}>{name ?? parameter.name}</div>,
        createParameterInput(parameter)
    ]
    const createParameterStack = (group: string, heading: string, upper: AutomatableParameterFieldAdapter, lower?: AutomatableParameterFieldAdapter) => (
        <div className={`parameter-stack ${group}`}>
            <div className="label">{heading}</div>
            {createParameterRow(upper)}
            {isDefined(lower) ? createParameterRow(lower) : null}
        </div>
    )
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
        Dragging.attach(waveformCanvas, ({clientX}: PointerEvent) => {
            const {left, width} = waveformCanvas.getBoundingClientRect()
            const dl = clientX - (left + sampleStart.getValue() * width)
            const dr = clientX - (left + sampleEnd.getValue() * width)
            const nearest = Math.abs(dl) <= Math.abs(dr) ? {parameter: sampleStart, delta: dl} : {parameter: sampleEnd, delta: dr}
            if (Math.abs(nearest.delta) > SnapValueThresholdInPixels) {return Option.None}
            const {parameter, delta} = nearest
            return Option.wrap({
                update: ({clientX}: Dragging.Event): void => {
                    const {left, width} = waveformCanvas.getBoundingClientRect()
                    editing.modify(() => parameter.setValue(clamp((clientX - delta - left) / width, 0.0, 1.0)), false)
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
                              {createParameterStack("tone", "Tone", rootKey, octave)}
                              {createParameterStack("waveform", "Waveform", sampleStart, sampleEnd)}
                              <div className="parameter-stack loop">
                                  <div className="label">Loop</div>
                                  {createParameterRow(loopStart, "Start")}
                                  {createParameterRow(loopFade, "Fade", true)}
                                  {createParameterRow(loopEnd, "End")}
                                  <div className="name second">Enabled</div>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={loop}>
                                      <Checkbox lifecycle={lifecycle}
                                                model={EditWrapper.forAutomatableParameter(editing, loop)}
                                                className="toggle"
                                                appearance={{activeColor: Colors.green, framed: true}}>
                                          <Icon symbol={IconSymbol.Checkbox}/>
                                      </Checkbox>
                                  </AutomationControl>
                              </div>
                              {createParameterStack("envelope", "Envelope", attack, release)}
                              {createParameterStack("output", "Output", volume)}
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
