import {MidiKeys} from "@opendaw/lib-dsp"
import {isAbsent, Optional} from "@opendaw/lib-std"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {Fonts} from "@/ui/Fonts"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {fitTunerCanvas, TunerLayout, tunerMeterX} from "./TunerCanvasLayout"
import {tunerHistoryKeys} from "./TunerHistoryAxis"
import {tunerNoteName} from "./TunerNoteName"
import {TunerPoint, TunerTiming, TunerViewState} from "./TunerViewState"

export class TunerRenderer {
    readonly #state: TunerViewState
    #context: Optional<CanvasRenderingContext2D>

    constructor(state: TunerViewState) {this.#state = state}

    paint(painter: CanvasPainter, now: number, histogram: boolean, strobe: boolean, frequency: boolean, reference: number): void {
        const context = painter.context
        this.#context = context
        const {scale, x, y} = fitTunerCanvas(painter.actualWidth, painter.actualHeight)
        context.setTransform(scale, 0, 0, scale, x, y)
        if (histogram) {this.#history(now)}
        else {this.#meter(strobe)}
        this.#readout(frequency, reference)
    }

    #history(now: number): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        const {center, span, display, visible} = this.#state
        for (const key of tunerHistoryKeys(center, span)) {
            const {note, y, top, height} = key
            context.fillStyle = Colors.dark.opacity(MidiKeys.isBlackKey(note) ? 0.025 : 0.06).toString()
            context.fillRect(TunerLayout.historyRight, top, TunerLayout.keyWidth, height)
            const selected = visible && note === Math.round(display.midi)
            if (selected) {
                context.save()
                context.globalAlpha = display.opacity
                context.fillStyle = Colors.green.toString()
                context.fillRect(TunerLayout.historyRight, top, TunerLayout.keyWidth, height)
                context.restore()
            }
            if (y >= TunerLayout.historyTop && y <= TunerLayout.historyBottom) {
                this.#line(TunerLayout.left, y, TunerLayout.historyRight, y, DisplayPaint.gridStyle())
                this.#text(tunerNoteName(note), TunerLayout.keyCenter, y + TunerLayout.keyLabelOffset,
                    Math.min(TunerLayout.maxKeyFont, TunerLayout.historyHeight / span * TunerLayout.keyFontRatio),
                    selected ? Colors.panelBackground.toString() : Colors.shadow.toString())
            }
        }
        context.save()
        context.beginPath()
        context.rect(TunerLayout.left, TunerLayout.historyTop,
            TunerLayout.historyRight - TunerLayout.left, TunerLayout.historyHeight)
        context.clip()
        context.beginPath()
        const plotWidth = TunerLayout.historyRight - TunerLayout.left
        const yOf = (midi: number) => TunerLayout.historyCenter - (midi - center) / span * TunerLayout.historyHeight
        const cursor: {previous: Optional<TunerPoint>} = {previous: undefined}
        for (const point of this.#state.history) {
            if (!Number.isFinite(point.midi)) {cursor.previous = undefined; continue}
            const x = TunerLayout.historyRight - (now - point.time) / TunerTiming.history * plotWidth
            const y = yOf(point.midi)
            const previous = cursor.previous
            if (isAbsent(previous) || Math.abs(point.midi - previous.midi) > 1.5 || point.time - previous.time > 100) {
                context.moveTo(x, y)
            } else {context.lineTo(x, y)}
            cursor.previous = point
        }
        context.strokeStyle = Colors.green.toString()
        context.lineWidth = TunerLayout.traceWidth
        context.stroke()
        context.restore()
    }

    #meter(strobe: boolean): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        const {display, visible, cents, phase} = this.#state
        const guide = DisplayPaint.strokeStyle(visible ? 0.6 : 0.35)
        this.#line(TunerLayout.left, TunerLayout.meterY, TunerLayout.right, TunerLayout.meterY, guide)
        for (let value = -TunerLayout.centsLimit; value <= TunerLayout.centsLimit; value += TunerLayout.tickStep) {
            const x = tunerMeterX(value)
            this.#line(x, TunerLayout.tickTop, x, TunerLayout.tickBottom, guide)
        }
        this.#line(TunerLayout.center, TunerLayout.zeroTop, TunerLayout.center,
            TunerLayout.zeroBottom, Colors.green.toString(), TunerLayout.zeroWidth)
        this.#text("0", TunerLayout.center, TunerLayout.scaleLabelY, TunerLayout.zeroFont, Colors.gray.toString())
        this.#text("−50", TunerLayout.left, TunerLayout.scaleLabelY, TunerLayout.scaleFont,
            Colors.shadow.toString(), "left")
        this.#text("+50", TunerLayout.right, TunerLayout.scaleLabelY, TunerLayout.scaleFont,
            Colors.shadow.toString(), "right")
        context.save()
        context.globalAlpha = display.opacity
        if (strobe) {
            for (let index = 0; index < TunerLayout.strobeCount; index++) {
                const position = ((index / TunerLayout.strobeCount + phase) % 1 + 1) % 1
                const x = TunerLayout.left + position * (TunerLayout.right - TunerLayout.left)
                this.#line(x, TunerLayout.strobeTop, x, TunerLayout.strobeBottom, this.#color(), TunerLayout.strobeWidth)
            }
        } else if (visible) {
            const x = tunerMeterX(cents)
            context.beginPath()
            context.moveTo(x, TunerLayout.triangleTip)
            context.lineTo(x - TunerLayout.triangleHalfWidth, TunerLayout.triangleTop)
            context.lineTo(x + TunerLayout.triangleHalfWidth, TunerLayout.triangleTop)
            context.closePath()
            context.fillStyle = this.#color()
            context.fill()
        }
        context.restore()
    }

    #readout(frequency: boolean, reference: number): void {
        const context = this.#context
        if (isAbsent(context) || !this.#state.visible) {return}
        const {display, cents} = this.#state
        const hz = reference * Math.pow(2, (display.midi - 69) / 12)
        context.save()
        context.globalAlpha = display.opacity
        this.#text(tunerNoteName(display.midi), TunerLayout.noteX, TunerLayout.readoutY,
            TunerLayout.readoutFont, this.#color())
        this.#text(frequency ? `${hz.toFixed(1)} Hz` : `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} ct`,
            TunerLayout.valueX, TunerLayout.readoutY, TunerLayout.readoutFont, this.#color())
        context.restore()
    }

    #color(): string {return (Math.abs(this.#state.cents) <= 5 ? Colors.green : Colors.orange).toString()}

    #text(value: string, x: number, y: number, size: number, fill: string, align: CanvasTextAlign = "center"): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        context.font = `300 ${size}px ${Fonts.Rubik["font-family"]}, sans-serif`
        context.textAlign = align
        context.fillStyle = fill
        context.fillText(value, x, y)
    }

    #line(x1: number, y1: number, x2: number, y2: number, stroke: string, thickness = 1): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        context.beginPath()
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
        context.strokeStyle = stroke
        context.lineWidth = thickness
        context.stroke()
    }
}
