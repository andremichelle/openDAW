import {MidiKeys} from "@opendaw/lib-dsp"
import {isAbsent, Optional} from "@opendaw/lib-std"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {Fonts} from "@/ui/Fonts"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {TunerCanvasLayout, TunerLayout} from "./TunerCanvasLayout"
import {TunerHistoryAxis} from "./TunerHistoryAxis"
import {TunerPoint, TunerTiming, TunerViewState} from "./TunerViewState"

export class TunerRenderer {
    readonly #state: TunerViewState
    #context: Optional<CanvasRenderingContext2D>
    #frame: TunerCanvasLayout.Frame

    constructor(state: TunerViewState) {
        this.#state = state
        this.#frame = TunerCanvasLayout.fit(TunerLayout.minWidth, TunerLayout.height)
    }

    paint(painter: CanvasPainter, now: number, histogram: boolean, strobe: boolean, frequency: boolean, reference: number): void {
        const context = painter.context
        this.#context = context
        this.#frame = TunerCanvasLayout.fit(painter.actualWidth, painter.actualHeight, painter.devicePixelRatio)
        context.setTransform(this.#frame.scale, 0, 0, this.#frame.scale, 0, this.#frame.y)
        if (histogram) {this.#history(now)}
        else {this.#meter(strobe)}
        this.#readout(frequency, reference)
    }

    #history(now: number): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        const {center, span, display, visible} = this.#state
        const font = this.#frame.keyFont
        const rows = TunerLayout.historyHeight / span / font
        context.save()
        context.beginPath()
        context.rect(this.#frame.left, TunerLayout.historyTop,
            this.#frame.right - this.#frame.left, TunerLayout.historyHeight)
        context.clip()
        for (const key of TunerHistoryAxis.keys(center, span)) {
            const {note, y, top, height} = key
            context.fillStyle = Colors.dark.opacity(MidiKeys.isBlackKey(note) ? 0.025 : 0.06).toString()
            context.fillRect(this.#frame.keyLeft, top, TunerLayout.keyWidth, height)
            const selected = visible && note === Math.round(display.midi)
            if (selected) {
                context.save()
                context.globalAlpha = display.opacity
                context.fillStyle = Colors.green.toString()
                context.fillRect(this.#frame.keyLeft, top, TunerLayout.keyWidth, height)
                context.restore()
            }
            this.#line(this.#frame.left, y, this.#frame.historyRight, y, DisplayPaint.gridStyle())
            if (selected || TunerHistoryAxis.labeled(note, rows)) {
                this.#text(MidiKeys.toFullString(note), this.#frame.keyCenter, y + font * 0.35, font,
                    selected ? Colors.panelBackground.toString() : Colors.shadow.toString())
            }
        }
        context.restore()
        context.save()
        context.beginPath()
        context.rect(this.#frame.left, TunerLayout.historyTop,
            this.#frame.historyRight - this.#frame.left, TunerLayout.historyHeight)
        context.clip()
        context.beginPath()
        const plotWidth = this.#frame.historyRight - this.#frame.left
        const yOf = (midi: number) => TunerLayout.historyCenter - (midi - center) / span * TunerLayout.historyHeight
        const cursor: {previous: Optional<TunerPoint>} = {previous: undefined}
        for (const point of this.#state.history) {
            if (!Number.isFinite(point.midi)) {cursor.previous = undefined; continue}
            const x = this.#frame.historyRight - (now - point.time) / TunerTiming.history * plotWidth
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
        this.#fadeEdges()
    }

    #fadeEdges(): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        const {historyTop, historyBottom, edgeFade} = TunerLayout
        const width = this.#frame.right - this.#frame.left
        context.save()
        context.globalCompositeOperation = "destination-out"
        const top = context.createLinearGradient(0, historyTop, 0, historyTop + edgeFade)
        top.addColorStop(0, "black")
        top.addColorStop(1, "transparent")
        context.fillStyle = top
        context.fillRect(this.#frame.left, historyTop, width, edgeFade)
        const bottom = context.createLinearGradient(0, historyBottom - edgeFade, 0, historyBottom)
        bottom.addColorStop(0, "transparent")
        bottom.addColorStop(1, "black")
        context.fillStyle = bottom
        context.fillRect(this.#frame.left, historyBottom - edgeFade, width, edgeFade)
        context.restore()
    }

    #meter(strobe: boolean): void {
        const context = this.#context
        if (isAbsent(context)) {return}
        const {display, visible, cents, phase} = this.#state
        const guide = DisplayPaint.strokeStyle(visible ? 0.6 : 0.35)
        this.#line(this.#frame.meterLeft, TunerLayout.meterY, this.#frame.meterRight, TunerLayout.meterY, guide)
        for (let value = -TunerLayout.centsLimit; value <= TunerLayout.centsLimit; value += TunerLayout.tickStep) {
            const x = TunerCanvasLayout.meterX(this.#frame, value)
            this.#line(x, TunerLayout.tickTop, x, TunerLayout.tickBottom, guide)
        }
        this.#line(this.#frame.center, TunerLayout.zeroTop, this.#frame.center,
            TunerLayout.zeroBottom, Colors.green.toString(), TunerLayout.zeroWidth)
        this.#text("0", this.#frame.center, TunerLayout.scaleLabelY, this.#frame.labelFont, Colors.gray.toString())
        this.#text("−50", this.#frame.left, TunerLayout.scaleLabelY, this.#frame.labelFont,
            Colors.shadow.toString(), "left")
        this.#text("+50", this.#frame.right, TunerLayout.scaleLabelY, this.#frame.labelFont,
            Colors.shadow.toString(), "right")
        context.save()
        context.globalAlpha = display.opacity
        if (strobe) {
            for (let index = 0; index < TunerLayout.strobeCount; index++) {
                const position = ((index / TunerLayout.strobeCount + phase) % 1 + 1) % 1
                const x = this.#frame.meterLeft + position * (this.#frame.meterRight - this.#frame.meterLeft)
                this.#line(x, TunerLayout.strobeTop, x, TunerLayout.strobeBottom, this.#color(), TunerLayout.strobeWidth)
            }
        } else if (visible) {
            const x = TunerCanvasLayout.meterX(this.#frame, cents)
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
        if (isAbsent(context)) {return}
        const {display, visible} = this.#state
        const midi = visible ? display.midi : display.last
        const [note, value] = this.#readoutTexts(midi, frequency, reference)
        if (!visible || display.opacity < 1) {
            this.#text(note, this.#frame.left, TunerLayout.readoutY, this.#frame.readoutFont, Colors.shadow.toString(), "left")
            this.#text(value, this.#frame.right, TunerLayout.readoutY, this.#frame.readoutFont, Colors.shadow.toString(), "right")
        }
        if (!visible) {return}
        context.save()
        context.globalAlpha = display.opacity
        this.#text(note, this.#frame.left, TunerLayout.readoutY, this.#frame.readoutFont, this.#color(), "left")
        this.#text(value, this.#frame.right, TunerLayout.readoutY, this.#frame.readoutFont, this.#color(), "right")
        context.restore()
    }

    #readoutTexts(midi: number, frequency: boolean, reference: number): [string, string] {
        if (!Number.isFinite(midi)) {return ["–", frequency ? "– Hz" : "– ct"]}
        const cents = (midi - Math.round(midi)) * 100
        const hz = reference * Math.pow(2, (midi - 69) / 12)
        return [MidiKeys.toFullString(Math.round(midi)),
            frequency ? `${hz.toFixed(1)} Hz` : `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} ct`]
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
