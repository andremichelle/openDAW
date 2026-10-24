import {clamp, DefaultObservableValue, isDefined, Lifecycle, Option, Optional} from "@opendaw/lib-std"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, TunerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {DeviceEditor} from "@/ui/devices/DeviceEditor"
import {MenuItems} from "@/ui/devices/menu-items"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter"
import {ToggleButton} from "@/ui/devices/ToggleButton"
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
    const canvas: HTMLCanvasElement = <canvas/>
    const state = new TunerViewState(box.historyCenter.getValue(), box.historySpan.getValue())
    const renderer = new TunerRenderer(state)
    const pending: {timer: Optional<number>} = {timer: undefined}
    const range = (): TunerRange => ({center: box.historyCenter.getValue(), span: box.historySpan.getValue()})
    const update = () => state.update(performance.now(), box.enabled.getValue(),
        box.reference.getValue(), box.autoFollow.getValue(), range())
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        update()
        renderer.paint(painter, performance.now(), box.view.getValue() === 1, box.strobe.getValue(),
            box.showFrequency.getValue(), box.reference.getValue())
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
        ...[box.enabled, box.reference, box.view, box.showFrequency, box.strobe,
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
    const tabs = ["Meter", "Hist"].map((label, index) => {
        const active = lifecycle.own(new DefaultObservableValue(false))
        lifecycle.own(box.view.catchupAndSubscribe(field => active.setValue(field.getValue() === index)))
        return <ToggleButton lifecycle={lifecycle} active={active}
            onClick={() => editing.modify(() => box.view.setValue(index))}>{label}</ToggleButton>
    })
    const modeActive = lifecycle.own(new DefaultObservableValue(false))
    const modeLabel: HTMLElement = <span/>
    const mode = <ToggleButton lifecycle={lifecycle} active={modeActive}
        onClick={() => editing.modify(() => {
            if (box.view.getValue() === 1) {
                if (box.autoFollow.getValue()) {box.historyCenter.setValue(clamp(state.center, 12, 120))}
                box.autoFollow.setValue(!box.autoFollow.getValue())
            } else {box.strobe.setValue(!box.strobe.getValue())}
        })}>{modeLabel}</ToggleButton>
    const updateMode = () => {
        const histogram = box.view.getValue() === 1
        const active = histogram ? box.autoFollow.getValue() : box.strobe.getValue()
        modeLabel.textContent = histogram ? (active ? "Auto" : "Manual") : (active ? "Strobe" : "Target")
        modeActive.setValue(active)
    }
    lifecycle.ownAll(box.view.catchupAndSubscribe(updateMode),
        box.autoFollow.subscribe(updateMode), box.strobe.subscribe(updateMode))
    const unitLabel: HTMLElement = <span/>
    const unit = <ToggleButton lifecycle={lifecycle} active={box.showFrequency}
        onClick={() => editing.modify(() => box.showFrequency.setValue(!box.showFrequency.getValue()))}>
        {unitLabel}
    </ToggleButton>
    lifecycle.own(box.showFrequency.catchupAndSubscribe(field => {
        unitLabel.textContent = field.getValue() ? "Hz" : "ct"
    }))
    return <DeviceEditor lifecycle={lifecycle} service={service} adapter={adapter}
        populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
        populateControls={() => <div className={className}>
            <div className="toggle-buttons">{tabs}{unit}{mode}</div>
            {canvas}
            <div className="reference"><span>Reference</span>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                    parameter={adapter.namedParameter.reference}>
                    <ParameterLabel lifecycle={lifecycle} parameter={adapter.namedParameter.reference} framed/>
                </RelativeUnitValueDragging>
            </div>
        </div>}
        populateMeter={() => <DevicePeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver}
            address={adapter.address}/>}
        icon={EffectFactories.AudioNamed.Tuner.defaultIcon}/>
}
