import css from "./FretDisplay.sass?inline"
import {int, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Guitar, Harmony} from "@opendaw/lib-dsp"
import {GuitarDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, Project} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "GuitarFretDisplay")

const Frets = 5

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: GuitarDeviceBoxAdapter
}

export const FretDisplay = ({lifecycle, project, adapter}: Construct) => {
    const {box} = adapter
    const {engine, timelineBoxAdapter: {chordTrack}, liveStreamReceiver} = project
    const name: HTMLElement = <div className="name"/>
    const detail: HTMLElement = <div className="detail"/>
    const footer: HTMLElement = <div className="footer"/>
    const shown = {tab: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>, lit: 0}
    const live = {frets: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>, lit: 0}
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, ({devicePixelRatio, context, actualWidth, actualHeight}) => {
        const {tab, lit} = shown
        const fretted = tab.filter(fret => fret > 0)
        const base = fretted.length === 0 || Math.max(...fretted) <= Frets - 1 ? 1 : Math.min(...fretted)
        const top = 14 * devicePixelRatio
        const left = 12 * devicePixelRatio
        const right = actualWidth - 14 * devicePixelRatio
        const bottom = actualHeight - 4 * devicePixelRatio
        const stringX = (string: int) => left + (right - left) * string / (Guitar.Strings - 1)
        const fretY = (line: int) => top + (bottom - top) * line / Frets
        context.lineWidth = devicePixelRatio
        context.strokeStyle = DisplayPaint.gridStyle(0.3)
        context.beginPath()
        for (let line = 0; line <= Frets; line++) {
            context.moveTo(left, fretY(line))
            context.lineTo(right, fretY(line))
        }
        context.stroke()
        if (base === 1) {
            context.fillStyle = Colors.cream.toString()
            context.fillRect(left - devicePixelRatio, top - 2 * devicePixelRatio, right - left + 2 * devicePixelRatio, 2.5 * devicePixelRatio)
        } else {
            context.fillStyle = Colors.cream.toString()
            context.font = `${8 * devicePixelRatio}px Rubik, sans-serif`
            context.textAlign = "left"
            context.textBaseline = "middle"
            context.fillText(String(base), right + 4 * devicePixelRatio, (fretY(0) + fretY(1)) / 2)
        }
        const radius = 4.5 * devicePixelRatio
        context.font = `${9 * devicePixelRatio}px Rubik, sans-serif`
        context.textAlign = "center"
        context.textBaseline = "middle"
        tab.forEach((fret, string) => {
            const on = (lit & (1 << string)) !== 0
            const x = stringX(string)
            context.lineWidth = (0.8 + (Guitar.Strings - 1 - string) * 0.2) * devicePixelRatio
            context.strokeStyle = on ? DisplayPaint.strokeStyle(1.0) : DisplayPaint.gridStyle(0.5)
            context.beginPath()
            context.moveTo(x, top)
            context.lineTo(x, bottom)
            context.stroke()
            const markY = top - 7 * devicePixelRatio
            if (fret < 0) {
                context.fillStyle = Colors.shadow.toString()
                context.fillText("×", x, markY)
            } else if (fret === 0) {
                context.lineWidth = devicePixelRatio
                context.strokeStyle = on ? DisplayPaint.strokeStyle(1.0) : Colors.cream.toString()
                context.beginPath()
                context.arc(x, markY, 2.75 * devicePixelRatio, 0, Math.PI * 2)
                context.stroke()
            } else {
                context.fillStyle = on ? Colors.white.toString() : DisplayPaint.strokeStyle(0.9)
                context.beginPath()
                context.arc(x, (fretY(fret - base) + fretY(fret - base + 1)) / 2, radius, 0, Math.PI * 2)
                context.fill()
            }
        })
    }))
    const update = () => {
        const tuning = box.tuning.getValue()
        const position = box.position.getValue()
        const keys = box.mode.getValue() === 1
        const chord = chordTrack.chordAt(engine.position.getValue())
        if (keys) {
            shown.tab = live.frets
            name.textContent = "Keys"
            detail.textContent = "played on the strings"
        } else {
            shown.tab = chord.mapOr(({root, bits}) => Guitar.tab(root, bits, tuning, position),
                new Array<int>(Guitar.Strings).fill(Guitar.Muted))
            name.textContent = chord.mapOr(chord => Harmony.chordName(chord), "No Chord")
            detail.textContent = chord.nonEmpty() ? "from the chord track" : "add chords to the chord track"
        }
        shown.lit = engine.isPlaying.getValue() ? live.lit : 0
        footer.textContent = `${Guitar.TuningNames[tuning]} · ${Guitar.PositionNames[position]}`
        painter.requestUpdate()
    }
    lifecycle.ownAll(
        engine.position.subscribe(update),
        engine.isPlaying.subscribe(update),
        chordTrack.subscribe(update),
        box.tuning.subscribe(update),
        box.position.subscribe(update),
        box.mode.subscribe(update),
        liveStreamReceiver.subscribeIntegers(adapter.address.append(0), array => {
            live.frets = Array.from(array.slice(2, 8))
            live.lit = array[8]
            update()
        })
    )
    update()
    return (
        <div className={className}>
            <header>
                {name}
                {detail}
                {canvas}
                {footer}
            </header>
        </div>
    )
}
