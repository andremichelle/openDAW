import {clamp, isDefined, Lifecycle, MutableObservableValue, Option, Optional} from "@opendaw/lib-std"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, TunerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {DeviceEditor} from "@/ui/devices/DeviceEditor"
import {MenuItems} from "@/ui/devices/menu-items"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import css from "./TunerDeviceEditor.sass?inline"
import {TunerRangeGesture} from "./TunerRangeGesture"
import {TunerRenderer} from "./TunerRenderer"
import {TunerRange, TunerTiming, TunerViewState} from "./TunerViewState"

const className = Html.adoptStyleSheet(css, "TunerDeviceEditor")
type Construct = {lifecycle: Lifecycle, service: StudioService, adapter: TunerDeviceBoxAdapter, deviceHost: DeviceHost}

export const TunerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const {box} = adapter
    const {reference} = adapter.namedParameter
    const canvas: HTMLCanvasElement = <canvas/>
    const state = new TunerViewState(box.historyCenter.getValue(), box.historySpan.getValue())
    const renderer = new TunerRenderer(state)
    const pending: {timer: Optional<number>} = {timer: undefined}
    const range = (): TunerRange => ({center: box.historyCenter.getValue(), span: box.historySpan.getValue()})
    const update = () => state.update(performance.now(), box.enabled.getValue(),
        reference.getControlledValue(), box.autoFollow.getValue(), range())
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        update()
        renderer.paint(painter, performance.now(), box.view.getValue() === 1, box.strobe.getValue(),
            box.showFrequency.getValue(), reference.getControlledValue())
    }))
    const refresh = () => {
        update()
        painter.requestUpdate()
        if (isDefined(pending.timer) || !state.animating(box.view.getValue() === 1)) {return}
        pending.timer = window.setTimeout(() => {
            pending.timer = undefined
            refresh()
        }, TunerTiming.interval)
    }
    lifecycle.ownAll(
        {terminate: () => {if (isDefined(pending.timer)) {window.clearTimeout(pending.timer)}}},
        project.liveStreamReceiver.subscribeFloats(adapter.address.append(0), values => {
            if (state.receive(values, performance.now())) {refresh()}
        }),
        reference.subscribe(refresh),
        ...[box.enabled, box.view, box.showFrequency, box.strobe,
            box.autoFollow, box.historyCenter, box.historySpan].map(field => field.subscribe(refresh)),
        Dragging.attach(canvas, event => {
            if (box.view.getValue() !== 1) {return Option.None}
            const gesture = new TunerRangeGesture(state, canvas.clientWidth, canvas.clientHeight,
                range => editing.modify(() => {
                    box.autoFollow.setValue(false)
                    box.historyCenter.setValue(range.center)
                    box.historySpan.setValue(range.span)
                }))
            return Option.wrap({
                update: (position: Dragging.Event) => {
                    gesture.move(position.clientX - event.clientX, position.clientY - event.clientY)
                    refresh()
                },
                approve: () => gesture.approve(),
                cancel: () => gesture.cancel(),
                finally: refresh
            })
        }),
        Events.subscribe(canvas, "dblclick", () => {
            if (box.view.getValue() === 1) {editing.modify(() => box.autoFollow.setValue(true))}
        })
    )
    const follow: MutableObservableValue<boolean> = {
        getValue: () => box.autoFollow.getValue(),
        setValue: (value: boolean) => editing.modify(() => {
            if (!value && box.autoFollow.getValue()) {box.historyCenter.setValue(clamp(state.center, 12, 120))}
            box.autoFollow.setValue(value)
        }),
        subscribe: observer => box.autoFollow.subscribe(() => observer(follow)),
        catchupAndSubscribe: observer => {
            observer(follow)
            return follow.subscribe(observer)
        }
    }
    const displayHeading: HTMLElement = <h1/>
    const meterDisplay: HTMLElement = (
        <RadioGroup lifecycle={lifecycle} appearance={{framed: true}}
                    model={EditWrapper.forValue(editing, box.strobe)}
                    elements={[
                        {value: false, element: <span>Needle</span>, tooltip: "A marker points at the deviation"},
                        {value: true, element: <span>Strobe</span>, tooltip: "Stripes move while out of tune and stand still in tune"}
                    ]}/>
    )
    const historyDisplay: HTMLElement = (
        <RadioGroup lifecycle={lifecycle} appearance={{framed: true}} model={follow}
                    elements={[
                        {value: true, element: <span>Follow</span>, tooltip: "The note range follows the played note"},
                        {value: false, element: <span>Fixed</span>, tooltip: "Drag to pan and zoom, double-click to follow again"}
                    ]}/>
    )
    lifecycle.own(box.view.catchupAndSubscribe(field => {
        const history = field.getValue() === 1
        displayHeading.textContent = history ? "Range" : "Display"
        meterDisplay.classList.toggle("hidden", history)
        historyDisplay.classList.toggle("hidden", !history)
    }))
    return <DeviceEditor lifecycle={lifecycle} service={service} adapter={adapter}
        populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
        populateControls={() => <div className={className}>
            <div className="controls">
                <div>
                    <h1>View</h1>
                    <RadioGroup lifecycle={lifecycle} appearance={{framed: true}}
                                model={EditWrapper.forValue(editing, box.view)}
                                elements={[
                                    {value: 0, element: <span>Meter</span>, tooltip: "Deviation from the nearest note"},
                                    {value: 1, element: <span>History</span>, tooltip: "Pitch of the last eight seconds"}
                                ]}/>
                </div>
                <div>
                    {displayHeading}
                    <div className="stack">{meterDisplay}{historyDisplay}</div>
                </div>
                <div>
                    <h1>Readout</h1>
                    <RadioGroup lifecycle={lifecycle} appearance={{framed: true}}
                                model={EditWrapper.forValue(editing, box.showFrequency)}
                                elements={[
                                    {value: false, element: <span>Cents</span>, tooltip: "Deviation in cents"},
                                    {value: true, element: <span>Hz</span>, tooltip: "Frequency in Hertz"}
                                ]}/>
                </div>
                <div>
                    <h1>Reference</h1>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={adapter.namedParameter.reference}>
                        <ParameterLabel lifecycle={lifecycle} parameter={adapter.namedParameter.reference} framed/>
                    </RelativeUnitValueDragging>
                </div>
            </div>
            {canvas}
        </div>}
        populateMeter={() => <DevicePeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver}
            address={adapter.address}/>}
        icon={EffectFactories.AudioNamed.Tuner.defaultIcon}/>
}
