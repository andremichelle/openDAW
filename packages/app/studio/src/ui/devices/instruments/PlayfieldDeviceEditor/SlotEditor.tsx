import css from "./SlotEditor.sass?inline"
import {Dragging, Html} from "@opendaw/lib-dom"
import {asDefined, clamp, Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon"
import {AutomatableParameterFieldAdapter, Gate, PlayfieldSampleBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {Checkbox} from "@/ui/components/Checkbox"
import {ControlIndicator} from "@/ui/components/ControlIndicator"
import {MidiKeys} from "@opendaw/lib-dsp"
import {SlotUtils} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotUtils"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {SnapValueThresholdInPixels} from "@/ui/timeline/editors/value/ValueMoveModifier"
import {Colors} from "@opendaw/studio-enums"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {PointerField} from "@opendaw/lib-box"

const className = Html.adoptStyleSheet(css, "SlotEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldSampleBoxAdapter
}

export const SlotEditor = ({lifecycle, service, adapter}: Construct) => {
    const {project} = service
    const {editing, midiLearning, userEditingManager} = project
    const deviceAdapter = adapter.device()
    const {
        sampleStart, sampleEnd, attack, release,
        pitch, mute, solo, gate, polyphone, exclude
    } = adapter.namedParameter
    const labelNote: HTMLElement = (<div className="note-label"/>)
    const waveformCanvas: HTMLCanvasElement = (<canvas/>)
    const playbackCanvas: HTMLCanvasElement = (<canvas style={{pointerEvents: "none"}}/>)
    const playbackContext: CanvasRenderingContext2D = asDefined(playbackCanvas.getContext("2d"))
    const waveformPainter = new CanvasPainter(waveformCanvas, painter =>
        SlotUtils.waveform(painter, adapter, adapter.indexField.getValue() % 12, true))
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forPointerField(adapter.box.file))
    const createParameterLabel = (parameter: AutomatableParameterFieldAdapter) => (
        <div className="parameter-label">
            <div className="label">{parameter.name}</div>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}>
                <ParameterLabel lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                adapter={deviceAdapter}
                                parameter={parameter}
                                framed standalone/>
            </RelativeUnitValueDragging>
        </div>
    )
    lifecycle.ownAll(
        waveformPainter,
        sampleSelector.configureDrop(waveformCanvas),
        adapter.indexField.catchupAndSubscribe(owner => labelNote.textContent = MidiKeys.toFullString(owner.getValue())),
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
                cancel: () => editing.clearPending(),
                approve: () => editing.mark()
            } satisfies Dragging.Process)
        }),
        adapter.box.device.subscribe((pointer: PointerField<Pointers.Sample>) => {
            if (!pointer.isAttached()) {return}
            userEditingManager.audioUnit.edit(deviceAdapter.audioUnitBoxAdapter().box.editing)
        }),
        adapter.box.file.subscribe(waveformPainter.requestUpdate),
        sampleStart.subscribe(waveformPainter.requestUpdate),
        sampleEnd.subscribe(waveformPainter.requestUpdate),
        service.project.liveStreamReceiver.subscribeFloats(adapter.address, array => {
            const {canvas} = playbackContext
            adapter.file().flatMap(file => file.data).match({
                none: () => {
                    canvas.width = canvas.clientWidth
                    canvas.height = canvas.clientHeight
                },
                some: data => {
                    canvas.width = canvas.clientWidth
                    canvas.height = canvas.clientHeight
                    playbackContext.fillStyle = SlotUtils.color(adapter.indexField.getValue() % 12)
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
        <div className={className}>
            <div className="display">
                <div className="waveform">
                    {waveformCanvas}
                    {playbackCanvas}
                </div>
            </div>
            <div className="columns">
                <div className="column">
                    {labelNote}
                    <div className="checkboxes">
                        <div>
                            <ControlIndicator lifecycle={lifecycle} parameter={mute}>
                                <Checkbox lifecycle={lifecycle}
                                          model={EditWrapper.forAutomatableParameter(editing, mute)}
                                          appearance={{activeColor: Colors.red, framed: true}}>
                                    <Icon symbol={IconSymbol.Mute}/>
                                </Checkbox>
                            </ControlIndicator>
                            <ControlIndicator lifecycle={lifecycle} parameter={solo}>
                                <Checkbox lifecycle={lifecycle}
                                          model={EditWrapper.forAutomatableParameter(editing, solo)}
                                          appearance={{activeColor: Colors.yellow, framed: true}}>
                                    <Icon symbol={IconSymbol.Solo}/>
                                </Checkbox>
                            </ControlIndicator>
                        </div>
                        <ControlIndicator lifecycle={lifecycle} parameter={exclude}>
                            <Checkbox lifecycle={lifecycle}
                                      model={EditWrapper.forAutomatableParameter(editing, exclude)}
                                      className="exclude"
                                      appearance={{activeColor: Colors.orange, framed: true}}>
                                <span style={{fontSize: "0.5em"}}>Excl.</span>
                            </Checkbox>
                        </ControlIndicator>
                    </div>
                </div>
                <div className="column">
                    <div className="label">Gate</div>
                    <RadioGroup lifecycle={lifecycle}
                                model={EditWrapper.forAutomatableParameter(editing, gate)}
                                className="radio-group"
                                elements={[
                                    {value: Gate.Off, element: (<span>Off</span>)},
                                    {value: Gate.On, element: (<span>On</span>)},
                                    {value: Gate.Loop, element: (<span>Loop</span>)}
                                ]}
                    />
                </div>
                <div className="column">
                    <div className="label">Voice</div>
                    <RadioGroup lifecycle={lifecycle}
                                model={EditWrapper.forAutomatableParameter(editing, polyphone)}
                                className="radio-group"
                                elements={[
                                    {value: false, element: (<span>Mono</span>)},
                                    {value: true, element: (<span>Poly</span>)}
                                ]}
                    />
                </div>
                {createParameterLabel(sampleStart)}
                {createParameterLabel(sampleEnd)}
                {createParameterLabel(attack)}
                {createParameterLabel(release)}
                {createParameterLabel(pitch)}
            </div>
        </div>
    )
}