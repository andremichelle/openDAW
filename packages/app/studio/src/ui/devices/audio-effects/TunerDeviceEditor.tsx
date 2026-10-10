import css from "./TunerDeviceEditor.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, TunerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DeviceEditor} from "@/ui/devices/DeviceEditor"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter"
import {MenuItems} from "@/ui/devices/menu-items"
import {TunerDisplayState} from "./TunerDisplayState"
import {fitTunerCanvas, tunerMeterX} from "./TunerCanvasLayout"
import {tunerNoteName} from "./TunerNoteName"
import {Colors} from "@opendaw/studio-enums"
import {Fonts} from "@/ui/Fonts"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import toggleCss from "@/ui/devices/ParameterToggleButton.sass?inline"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {tunerHistoryKeys} from "./TunerHistoryAxis"
import {MidiKeys} from "@opendaw/lib-dsp"

const className = Html.adoptStyleSheet(css, "TunerDeviceEditor")
const toggleClassName = Html.adoptStyleSheet(toggleCss, "TunerToggleButton")
const HISTORY_SECONDS = 8
type Point = {time: number, midi: number}
type Construct = {lifecycle: Lifecycle, service: StudioService, adapter: TunerDeviceBoxAdapter, deviceHost: DeviceHost}

export const TunerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const {box} = adapter
    const canvas: HTMLCanvasElement = <canvas tabIndex={0} aria-label="Live chromatic tuner: pitch and tuning deviation"/>
    const values = new Float32Array([0, 0, -120])
    let received = -Infinity, lastFrame = performance.now(), lastPoint = -Infinity
    let smoothed = NaN, center = box.historyCenter.getValue(), phase = 0
    const display = new TunerDisplayState()
    const history: Point[] = []
    lifecycle.own(project.liveStreamReceiver.subscribeFloats(adapter.address.append(0), incoming => {
        values.set(incoming)
        received = performance.now()
    }))
    const name = (midi: number) => tunerNoteName(midi, box.spelling.getValue())
    const context = canvas.getContext("2d")!
    const paint = () => {
        const now = performance.now(), dt = Math.min((now - lastFrame) / 1000, 0.1)
        lastFrame = now
        const enabled = box.enabled.getValue()
        const valid = enabled && now - received < 300 && Number.isFinite(values[0]) && values[0] >= 30
            && values[1] >= 0.85
        const rawMidi = valid ? 69 + 12 * Math.log2(values[0] / box.reference.getValue()) : NaN
        if (!enabled) {display.reset()}
        display.update(rawMidi, now, box.smooth.getValue())
        smoothed = display.midi
        const visible = Number.isFinite(smoothed) && display.opacity > 0
        const cents = visible ? (smoothed - Math.round(smoothed)) * 100 : 0
        if (now - lastPoint >= 1000 / 30) {
            history.push({time: now, midi: valid ? smoothed : NaN})
            lastPoint = now
        }
        while (history.length && now - history[0].time > HISTORY_SECONDS * 1000) {history.shift()}
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {return}
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio)
        if (canvas.width !== width || canvas.height !== height) {canvas.width = width; canvas.height = height}
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.globalAlpha = 1
        context.clearRect(0, 0, width, height)
        // One uniform scale preserves round targets and readable typography at every DPR.
        const {scale, x, y} = fitTunerCanvas(width, height)
        context.setTransform(scale, 0, 0, scale, x, y)
        const color = (Math.abs(cents) <= 5 ? Colors.green : Colors.orange).toString()
        const text = (value: string, x: number, y: number, size: number, fill = Colors.gray.toString(), align: CanvasTextAlign = "center") => {
            context.font = `300 ${size}px ${Fonts.Rubik["font-family"]}, sans-serif`
            context.textAlign = align
            context.fillStyle = fill
            context.fillText(value, x, y)
        }
        const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, thickness = 1) => {
            context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2)
            context.strokeStyle = stroke; context.lineWidth = thickness; context.stroke()
        }
        const frequency = visible ? box.reference.getValue() * Math.pow(2, (smoothed - 69) / 12) : 0
        const view = box.view.getValue()
        const plotLeft = `${(x + 18 * scale) / ratio}px`
        const panelStyle = canvas.parentElement!.style
        if (panelStyle.getPropertyValue("--plot-left") !== plotLeft) {panelStyle.setProperty("--plot-left", plotLeft)}
        if (view === 2) {
            if (box.autoFollow.getValue() && valid) {center += (Math.round(smoothed) - center) * (1 - Math.exp(-dt / 0.2))}
            else if (!box.autoFollow.getValue()) {center = box.historyCenter.getValue()}
            const span = box.historySpan.getValue()
            const yOf = (midi: number) => 105 - (midi - center) / span * 180
            for (const key of tunerHistoryKeys(center, span)) {
                const {note, y, top, height} = key
                context.fillStyle = Colors.dark.opacity(MidiKeys.isBlackKey(note) ? 0.025 : 0.06).toString()
                context.fillRect(418, top, 58, height)
                const selected = visible && note === Math.round(smoothed)
                if (selected) {
                    context.save()
                    context.globalAlpha = display.opacity
                    context.fillStyle = Colors.green.toString()
                    context.fillRect(418, top, 58, height)
                    context.restore()
                }
                if (y >= 15 && y <= 195) {
                    line(18, y, 418, y, DisplayPaint.gridStyle())
                    const labelColor = selected ? Colors.panelBackground.toString() : Colors.shadow.toString()
                    text(name(note), 447, y + 5, Math.min(18, 180 / span * 0.65), labelColor)
                }
            }
            context.save()
            context.beginPath(); context.rect(18, 15, 400, 180); context.clip()
            context.beginPath()
            let previous: Point | undefined
            for (const point of history) {
                if (!Number.isFinite(point.midi)) {previous = undefined; continue}
                const x = 418 - (now - point.time) / (HISTORY_SECONDS * 1000) * 400, y = yOf(point.midi)
                if (!previous || Math.abs(point.midi - previous.midi) > 1.5 || point.time - previous.time > 100) {context.moveTo(x, y)}
                else {context.lineTo(x, y)}
                previous = point
            }
            context.strokeStyle = Colors.green.toString(); context.lineWidth = 2; context.stroke()
            context.restore()
        } else {
            const guide = `rgba(255, 255, 255, ${visible ? 0.6 : 0.35})`
            line(tunerMeterX(-50), 90, tunerMeterX(50), 90, guide)
            for (let value = -50; value <= 50; value += 10) {
                const x = tunerMeterX(value)
                line(x, 85, x, 95, guide)
            }
            line(240, 76, 240, 110, Colors.green.toString(), 3)
            text("0", 240, 137, 17, Colors.gray.toString())
            text("−50", 18, 137, 16, "rgba(255, 255, 255, 0.125)", "left")
            text("+50", 462, 137, 16, "rgba(255, 255, 255, 0.125)", "right")
            context.save()
            context.globalAlpha = display.opacity
            if (view === 1) {
                if (valid) {phase = (phase + cents * dt / 100) % 1}
                for (let index = 0; index < 20; index++) {
                    const position = ((index / 20 + phase) % 1 + 1) % 1
                    const x = 18 + position * 444
                    line(x, 57, x, 70, color, 4)
                }
            } else if (visible) {
                const x = tunerMeterX(cents)
                context.beginPath()
                context.moveTo(x, 83)
                context.lineTo(x - 11, 63)
                context.lineTo(x + 11, 63)
                context.closePath()
                context.fillStyle = color; context.fill()
            }
            context.restore()
        }
        context.save()
        context.globalAlpha = display.opacity
        if (visible) {
            text(name(smoothed), 112, 205, 36, color)
            text(box.showFrequency.getValue() ? `${frequency.toFixed(1)} Hz`
                : `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} ct`, 305, 205, 36, color)
        }
        context.restore()
        const message = !enabled ? "BYPASSED" : !valid ? "WAITING FOR A CLEAR NOTE"
            : Math.abs(cents) <= 5 ? "IN TUNE" : cents < 0 ? "TUNE UP" : "TUNE DOWN"
        canvas.setAttribute("aria-label", valid ? `${name(smoothed)}, ${cents.toFixed(1)} cents, ${message}` : message)
    }
    let drag: {x: number, y: number, center: number, span: number} | undefined
    lifecycle.ownAll(
        AnimationFrame.add(paint),
        Events.subscribe(canvas, "keydown", event => {
            if (box.view.getValue() !== 2) {return}
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {return}
            event.preventDefault()
            editing.modify(() => {
                box.autoFollow.setValue(false)
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    box.historyCenter.setValue(Math.max(12, Math.min(120, center + (event.key === "ArrowUp" ? 1 : -1))))
                } else {
                    box.historyCenter.setValue(Math.max(12, Math.min(120, center)))
                    box.historySpan.setValue(Math.max(2, Math.min(24, box.historySpan.getValue() * (event.key === "ArrowRight" ? 1.2 : 1 / 1.2))))
                }
            })
        }),
        Events.subscribe(canvas, "pointerdown", event => {
            if (box.view.getValue() !== 2) {return}
            canvas.setPointerCapture(event.pointerId)
            drag = {x: event.clientX, y: event.clientY, center, span: box.historySpan.getValue()}
        }),
        Events.subscribe(canvas, "pointerup", event => {
            if (!drag) {return}
            const start = drag
            drag = undefined
            editing.modify(() => {
                box.autoFollow.setValue(false)
                box.historyCenter.setValue(Math.max(12, Math.min(120,
                    start.center + (event.clientY - start.y) / canvas.clientHeight * start.span)))
                box.historySpan.setValue(Math.max(2, Math.min(24,
                    start.span * Math.exp((event.clientX - start.x) / canvas.clientWidth * 2))))
            })
        }),
        Events.subscribe(canvas, "pointercancel", () => drag = undefined),
        Events.subscribe(canvas, "dblclick", () => {
            if (box.view.getValue() === 2) {editing.modify(() => box.autoFollow.setValue(true))}
        })
    )
    const tabs = ["Meter", "Histogram"].map((name, index) => {
        const button: HTMLButtonElement = <button type="button" className={toggleClassName}
            title={`${name} view`}
            onclick={() => editing.modify(() => box.view.setValue(index === 0 ? 0 : 2))}>
            {name}
        </button>
        button.setAttribute("role", "tab")
        button.setAttribute("aria-label", name)
        lifecycle.own(box.view.catchupAndSubscribe(field => {
            const active = index === 0 ? field.getValue() !== 2 : field.getValue() === 2
            button.setAttribute("aria-selected", String(active))
            button.classList.toggle("active", active)
            button.tabIndex = active ? 0 : -1
        }))
        lifecycle.own(Events.subscribe(button, "keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                editing.modify(() => box.view.setValue(index === 0 ? 0 : 2))
                return
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {return}
            event.preventDefault()
            const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index
            editing.modify(() => box.view.setValue(next === 0 ? 0 : 2))
            tabs[next].focus()
        }))
        return button
    })
    const reference = <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
        parameter={adapter.namedParameter.reference}>
        <ParameterLabel lifecycle={lifecycle} parameter={adapter.namedParameter.reference} framed/>
    </RelativeUnitValueDragging>
    const mode: HTMLButtonElement = <button type="button" className={`${toggleClassName} mode`}
        onclick={() => editing.modify(() => {
            if (box.view.getValue() === 2) {
                if (box.autoFollow.getValue()) {
                    // Freeze the visible center, not the last manually stored center.
                    box.historyCenter.setValue(Math.max(12, Math.min(120, center)))
                }
                box.autoFollow.setValue(!box.autoFollow.getValue())
            } else {box.view.setValue(box.view.getValue() === 1 ? 0 : 1)}
        })}/>
    const updateMode = () => {
        const histogram = box.view.getValue() === 2
        const active = histogram ? box.autoFollow.getValue() : box.view.getValue() === 1
        mode.textContent = histogram ? (active ? "Auto" : "Manual") : (active ? "Strobe" : "Target")
        mode.title = histogram ? "Switch Auto / Manual pitch range" : "Switch Target / Strobe"
        mode.setAttribute("aria-label", histogram ? "Automatically follow pitch" : "Strobe mode")
        mode.classList.toggle("active", active)
        mode.setAttribute("aria-pressed", String(active))
    }
    lifecycle.ownAll(box.view.catchupAndSubscribe(updateMode), box.autoFollow.subscribe(updateMode))
    const unit: HTMLButtonElement = <button type="button" className={`${toggleClassName} unit`}
        title="Switch cents / Hz" aria-label="Show frequency instead of cents"
        onclick={() => editing.modify(() => box.showFrequency.setValue(!box.showFrequency.getValue()))}/>
    lifecycle.own(box.showFrequency.catchupAndSubscribe(field => {
        unit.textContent = field.getValue() ? "Hz" : "ct"
        unit.classList.toggle("active", field.getValue())
        unit.setAttribute("aria-pressed", String(field.getValue()))
    }))
    return <DeviceEditor lifecycle={lifecycle} service={service} adapter={adapter}
        populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
        populateControls={() => <div className={className}>
            <div className="display">{canvas}<div className="display-footer">
                <div className="view-tabs" role="tablist" aria-label="Tuner view">{tabs}</div>
                {unit}{mode}
                <div className="reference"><span>Reference</span>{reference}</div>
            </div></div>
        </div>}
        populateMeter={() => <DevicePeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver}
            address={adapter.address}/>}
        icon={EffectFactories.AudioNamed.Tuner.defaultIcon}/>
}
