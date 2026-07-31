import css from "./EnvelopeEditor.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, Terminator} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {Address, Float32Field, Int32Field} from "@opendaw/lib-box"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {NeonEnvelope} from "@opendaw/studio-boxes"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "NeonEnvelopeEditor")

const STAGES = 8

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    envelopes: ReadonlyArray<NeonEnvelope> // ALL SIX: line1 pitch/DCW/DCA, line2 pitch/DCW/DCA
    lineIndex: DefaultObservableValue<int> // shared with the LINE tabs above
    receiver: LiveStreamReceiver
    address: Address // the engine's playhead broadcast (device address + [0])
}

// The measured envelope rate law (mirrors envelope.rs): seconds for a FULL 0-99 swing at `rate`,
// log-time interpolated through the VirtualCZ decay-ladder knots.
const RATE_POINTS: ReadonlyArray<[number, number]> = [
    [10.0, 40.43], [15.0, 20.28], [20.0, 14.45], [25.0, 8.509], [30.0, 4.240], [35.0, 2.519],
    [40.0, 1.820], [45.0, 0.901], [53.0, 0.428], [60.0, 0.187], [70.0, 0.064], [80.0, 0.028],
    [85.0, 0.014], [99.0, 0.0022]
]
const fullSwingSeconds = (rate: number): number => {
    const [firstRate, firstSeconds] = RATE_POINTS[0]
    const [lastRate, lastSeconds] = RATE_POINTS[RATE_POINTS.length - 1]
    if (rate <= firstRate) {return firstSeconds * Math.pow(2.0, (firstRate - rate) / 5.0)}
    if (rate >= lastRate) {return Math.max(0.0015, lastSeconds)}
    for (let index = 1; index < RATE_POINTS.length; index++) {
        const [x1, y1] = RATE_POINTS[index]
        if (rate <= x1) {
            const [x0, y0] = RATE_POINTS[index - 1]
            const t = (rate - x0) / (x1 - x0)
            return Math.max(0.0015, Math.pow(2.0, Math.log2(y0) + (Math.log2(y1) - Math.log2(y0)) * t))
        }
    }
    return Math.max(0.0015, lastSeconds)
}

const formatSeconds = (seconds: number): string =>
    seconds < 1.0 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`

const rateFields = (envelope: NeonEnvelope): ReadonlyArray<Float32Field> => [
    envelope.rate1, envelope.rate2, envelope.rate3, envelope.rate4,
    envelope.rate5, envelope.rate6, envelope.rate7, envelope.rate8
]
const levelFields = (envelope: NeonEnvelope): ReadonlyArray<Float32Field> => [
    envelope.level1, envelope.level2, envelope.level3, envelope.level4,
    envelope.level5, envelope.level6, envelope.level7, envelope.level8
]

// The tabbed 8-stage envelope editor (PITCH / DCW / DCA of the line selected by the shared L1/L2
// selector). Canvas: drag the NEAREST handle RELATIVE to its values (dx per slot = full rate range,
// dy = level; shift = ¼ fine). Below: the MARKER LANE — the S(ustain) and E(nd) badges live on the
// stage strip; DRAG a badge to move it (S left of stage 1 = off), CLICK a bare stage to move E there.
const PLAYHEAD_STRIDE = 12 // (position, level) x 6 envelopes per sounding voice, -2 closes the stream

export const EnvelopeEditor = ({lifecycle, editing, envelopes, lineIndex, receiver, address}: Construct) => {
    const playheads = new Float32Array(64).fill(-2)
    const tabIndex = lifecycle.own(new DefaultObservableValue<int>(2))
    const selectedStage = lifecycle.own(new DefaultObservableValue<int>(0))
    const stageLabel: HTMLElement = (<span/>)
    const timeValue: HTMLElement = (<span className="editable"/>)
    const levelValue: HTMLElement = (<span className="editable"/>)
    const readout: HTMLElement = (
        <div className="readout">
            {stageLabel}
            {timeValue}
            {levelValue}
        </div>
    )
    const canvas: HTMLCanvasElement = (<canvas/>)
    const lane: HTMLElement = (<div className="lane"/>)
    const active = (): NeonEnvelope => envelopes[lineIndex.getValue() * 3 + tabIndex.getValue()]
    const handleX = (stage: int, rate: number): number => (stage + (99.0 - rate) / 99.0) / STAGES
    const showStage = (stage: int) => {
        selectedStage.setValue(stage)
        const envelope = active()
        const rate = rateFields(envelope)[stage].getValue()
        const levels = levelFields(envelope)
        const level = levels[stage].getValue()
        const from = stage === 0 ? 0 : levels[stage - 1].getValue()
        const seconds = fullSwingSeconds(rate) * Math.abs(level - from) / 99.0
        stageLabel.textContent = `stage ${stage + 1}`
        timeValue.textContent = formatSeconds(seconds)
        levelValue.textContent = `level ${Math.round(level)}`
    }
    // Click-to-type on the readout: TIME resolves back through the measured rate law (rate from the
    // wanted swing time and the stage's level delta), LEVEL is the raw 0-99 value.
    const editNumber = (anchor: HTMLElement, current: number, unit: string, apply: (value: number) => void) => {
        const rect = anchor.getBoundingClientRect()
        const resolvers = Promise.withResolvers<string>()
        resolvers.promise.then(input => {
            const value = Number.parseFloat(input.replace(",", "."))
            if (Number.isFinite(value)) {
                editing.modify(() => apply(value))
                editing.mark()
            }
        }, () => {})
        Surface.get(anchor).flyout.appendChild(
            <FloatingTextInput position={{x: rect.left, y: rect.top + (rect.height >> 1)}}
                               value={String(current)}
                               unit={unit}
                               numeric
                               resolvers={resolvers}/>
        )
    }
    lifecycle.ownAll(
        Events.subscribe(timeValue, "pointerdown", (event: PointerEvent) => {
            event.stopPropagation()
            const stage = selectedStage.getValue()
            const envelope = active()
            const levels = levelFields(envelope)
            const level = levels[stage].getValue()
            const from = stage === 0 ? 0 : levels[stage - 1].getValue()
            const delta = Math.abs(level - from)
            const rate = rateFields(envelope)[stage].getValue()
            const seconds = fullSwingSeconds(rate) * delta / 99.0
            editNumber(timeValue, Number((seconds * 1000).toFixed(1)), "ms", milliseconds => {
                if (delta === 0) {return}
                const swing = Math.max(0.0015, milliseconds / 1000.0 * 99.0 / delta)
                const value = 60.0 - 6.7 * Math.log2(swing / 0.1967)
                rateFields(envelope)[stage].setValue(clamp(value, 0.0, 99.0))
                showStage(stage)
            })
        }),
        Events.subscribe(levelValue, "pointerdown", (event: PointerEvent) => {
            event.stopPropagation()
            const stage = selectedStage.getValue()
            const envelope = active()
            editNumber(levelValue, Math.round(levelFields(envelope)[stage].getValue()), "", level => {
                levelFields(envelope)[stage].setValue(clamp(level, 0.0, 99.0))
                showStage(stage)
            })
        })
    )
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const envelope = active()
        const rates = rateFields(envelope).map(field => field.getValue())
        const levels = levelFields(envelope).map(field => field.getValue())
        const sustain = envelope.sustain.getValue()
        const end = clamp(envelope.end.getValue(), 1, STAGES)
        const padding = devicePixelRatio * 3
        const top = padding
        const bottom = actualHeight - padding
        const levelToY = (level: number) => bottom + (top - bottom) * (level / 99.0)
        const slot = actualWidth / STAGES
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2, 3])
        context.strokeStyle = "rgba(255, 255, 255, 0.08)"
        context.beginPath()
        for (let stage = 1; stage < STAGES; stage++) {
            context.moveTo(stage * slot, top)
            context.lineTo(stage * slot, bottom)
        }
        context.stroke()
        context.setLineDash([])
        if (sustain > 0) {
            const x = sustain * slot
            context.strokeStyle = "rgba(255, 200, 80, 0.6)"
            context.setLineDash([3, 2])
            context.beginPath()
            context.moveTo(x, top)
            context.lineTo(x, bottom)
            context.stroke()
            context.setLineDash([])
        }
        const path = new Path2D()
        path.moveTo(0, levelToY(0))
        const endX = end * slot
        for (let stage = 0; stage < end; stage++) {
            path.lineTo(handleX(stage, rates[stage]) * actualWidth, levelToY(levels[stage]))
            path.lineTo((stage + 1) * slot, levelToY(levels[stage]))
        }
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.lineWidth = devicePixelRatio
        context.stroke(path)
        path.lineTo(endX, levelToY(0))
        path.lineTo(0, levelToY(0))
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.12))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.0))
        context.fillStyle = gradient
        context.fill(path)
        for (let stage = 0; stage < STAGES; stage++) {
            const x = handleX(stage, rates[stage]) * actualWidth
            const y = levelToY(levels[stage])
            context.beginPath()
            context.arc(x, y, devicePixelRatio * 2.5, 0.0, Math.PI * 2)
            context.fillStyle = stage < end ? DisplayPaint.strokeStyle(0.9) : DisplayPaint.strokeStyle(0.12)
            context.fill()
        }
        const envelopeOffset = (lineIndex.getValue() * 3 + tabIndex.getValue()) * 2
        for (let base = 0; base + PLAYHEAD_STRIDE <= playheads.length; base += PLAYHEAD_STRIDE) {
            if (playheads[base] === -2) {break}
            const position = playheads[base + envelopeOffset]
            if (position < 0) {continue}
            const positionStage = clamp(Math.floor(position), 0, STAGES - 1)
            const fraction = position - positionStage
            const rampStart = positionStage / STAGES
            const x = (rampStart + (handleX(positionStage, rates[positionStage]) - rampStart) * fraction) * actualWidth
            const y = levelToY(playheads[base + envelopeOffset + 1] * 99.0)
            context.beginPath()
            context.arc(x, y, devicePixelRatio * 1.5, 0.0, Math.PI * 2)
            context.fillStyle = "hsl(200, 83%, 75%)"
            context.fill()
        }
    }))
    lifecycle.own(receiver.subscribeFloats(address, values => {
        playheads.set(values.subarray(0, playheads.length))
        painter.requestUpdate()
    }))
    const rebuildLane = () => {
        const envelope = active()
        const sustain = envelope.sustain.getValue()
        const end = clamp(envelope.end.getValue(), 1, STAGES)
        const slots = Array.from({length: STAGES}, (_, index: int) => {
            const stage = index + 1
            const isSustain = sustain === stage
            const isEnd = end === stage
            const label = isSustain && isEnd ? "S·E" : isSustain ? "S" : isEnd ? "E" : String(stage)
            const classes = ["slot", isSustain ? "sustain" : "", isEnd ? "end" : "", stage > end ? "dead" : ""]
                .join(" ").trim()
            return <span className={classes} data-stage={String(stage)}>{label}</span>
        })
        const off: HTMLElement = (
            <span className={sustain === 0 ? "off-sustain visible" : "off-sustain"} data-stage="0">S</span>
        )
        Html.empty(lane)
        lane.appendChild(off)
        slots.forEach(slotElement => lane.appendChild(slotElement))
    }
    // One drag session on the lane: pick S or E (whichever badge is nearer at pointerdown, or E for a
    // bare-stage CLICK), then every horizontal move re-snaps that marker to the slot under the pointer.
    lifecycle.own(Events.subscribe(lane, "pointerdown", (event: PointerEvent) => {
        lane.setPointerCapture(event.pointerId)
        const rect = lane.getBoundingClientRect()
        const gutter = rect.width / (STAGES + 1)
        const slotAt = (clientX: number): int =>
            clamp(Math.floor((clientX - rect.left - gutter) / gutter) + 1, 0, STAGES)
        const envelope = active()
        const sustain = envelope.sustain.getValue()
        const end = clamp(envelope.end.getValue(), 1, STAGES)
        const sustainX = rect.left + (sustain === 0 ? 0.5 : sustain + 0.5) * gutter
        const endX = rect.left + (end + 0.5) * gutter
        const marker: "sustain" | "end" =
            Math.abs(event.clientX - sustainX) <= Math.abs(event.clientX - endX) ? "sustain" : "end"
        const apply = (clientX: number) => {
            const slot = slotAt(clientX)
            editing.modify(() => {
                if (marker === "sustain") {
                    envelope.sustain.setValue(slot)
                } else {
                    envelope.end.setValue(Math.max(1, slot))
                }
            }, false)
        }
        apply(event.clientX)
        const move = (moveEvent: PointerEvent) => apply(moveEvent.clientX)
        const up = () => {
            lane.removeEventListener("pointermove", move)
            lane.removeEventListener("pointerup", up)
            editing.mark()
        }
        lane.addEventListener("pointermove", move)
        lane.addEventListener("pointerup", up)
    }))
    lifecycle.own(TextTooltip.default(lane, () =>
        "Drag S (sustain, left of 1 = off) and E (end) to their stages"))
    const fieldWatcher = lifecycle.own(new Terminator())
    const watchActive = () => {
        fieldWatcher.terminate()
        const envelope = active()
        const fields: ReadonlyArray<Float32Field | Int32Field> =
            [...rateFields(envelope), ...levelFields(envelope), envelope.sustain, envelope.end]
        fields.forEach(field => fieldWatcher.own(field.subscribe(() => {
            painter.requestUpdate()
            rebuildLane()
            showStage(selectedStage.getValue())
        })))
        painter.requestUpdate()
        rebuildLane()
        showStage(selectedStage.getValue())
    }
    lifecycle.ownAll(
        tabIndex.subscribe(watchActive),
        lineIndex.subscribe(watchActive),
        Events.subscribe(canvas, "pointerdown", (event: PointerEvent) => {
            canvas.setPointerCapture(event.pointerId)
            const rect = canvas.getBoundingClientRect()
            const envelope = active()
            const rates = rateFields(envelope)
            const levels = levelFields(envelope)
            const downX = event.clientX
            const downY = event.clientY
            const distances = rates.map((field, index) => {
                const x = rect.left + handleX(index, field.getValue()) * rect.width
                const y = rect.top + rect.height * (1.0 - levels[index].getValue() / 99.0)
                return Math.hypot(x - downX, y - downY)
            })
            const stage = distances.indexOf(Math.min(...distances))
            const startRate = rates[stage].getValue()
            const startLevel = levels[stage].getValue()
            showStage(stage)
            const move = (moveEvent: PointerEvent) => {
                const fine = moveEvent.shiftKey ? 0.25 : 1.0
                const deltaRate = (moveEvent.clientX - downX) / (rect.width / STAGES) * 99.0 * fine
                const deltaLevel = (downY - moveEvent.clientY) / rect.height * 99.0 * fine
                const rate = clamp(startRate - deltaRate, 0.0, 99.0)
                const level = clamp(startLevel + deltaLevel, 0.0, 99.0)
                editing.modify(() => {
                    rates[stage].setValue(rate)
                    levels[stage].setValue(level)
                }, false)
                showStage(stage)
            }
            const up = () => {
                canvas.removeEventListener("pointermove", move)
                canvas.removeEventListener("pointerup", up)
                editing.mark()
            }
            canvas.addEventListener("pointermove", move)
            canvas.addEventListener("pointerup", up)
        })
    )
    watchActive()
    return (
        <div className={className}>
            <div className="tabs">
                <RadioGroup lifecycle={lifecycle}
                            model={tabIndex}
                            style={{fontSize: "9px"}}
                            elements={[
                                {value: 0, element: <span>PITCH</span>},
                                {value: 1, element: <span>DCW</span>},
                                {value: 2, element: <span>DCA</span>}
                            ]}/>
                {readout}
            </div>
            {canvas}
            {lane}
        </div>
    )
}
