import css from "./FretDisplay.sass?inline"
import {clamp, int, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Guitar, Harmony} from "@opendaw/lib-dsp"
import {GuitarDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, Project} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "GuitarFretDisplay")

const Frets = 5
const MaxBase = Guitar.MaxFret - Frets + 1
const WheelStep = 40
const Inlays: ReadonlyArray<int> = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: GuitarDeviceBoxAdapter
    selector: HTMLElement
}

export const FretDisplay = ({lifecycle, project, adapter, selector}: Construct) => {
    const {box, namedParameter: {chord, tuning: tuningParameter, position: positionParameter, mode}} = adapter
    const {editing, engine, timelineBoxAdapter: {chordTrack}, liveStreamReceiver} = project
    const name: HTMLElement = <div className="name"/>
    const lower: HTMLElement = <span className="arrow">‹</span>
    const higher: HTMLElement = <span className="arrow">›</span>
    const footerText: HTMLElement = <span/>
    const footer: HTMLElement = <div className="footer">{lower}{footerText}{higher}</div>
    const shown = {tab: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>, lit: 0, base: 1}
    const edit = {index: 0, base: 1, wheel: 0}
    const editingShape = () => edit.index > 0 && mode.getControlledValue() === 0
    const voicing = {key: "", tab: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>}
    const painted = {key: ""}
    const shapeField = () => box.shapes.getField(edit.index - 1)
    const fitBase = (tab: ReadonlyArray<int>): int => {
        const fretted = tab.filter(fret => fret > 0)
        return fretted.length === 0 || Math.max(...fretted) <= Frets - 1 ? 1 : clamp(Math.min(...fretted), 1, MaxBase)
    }
    const live = {frets: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>, lit: 0}
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, ({devicePixelRatio, context, actualWidth, actualHeight}) => {
        const {tab, lit, base} = shown
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
        }
        context.font = `${8 * devicePixelRatio}px Rubik, sans-serif`
        context.textAlign = "left"
        context.textBaseline = "middle"
        for (let row = 0; row < Frets; row++) {
            const fret = base + row
            const inlay = Inlays.includes(fret)
            const centerY = (fretY(row) + fretY(row + 1)) / 2
            if (inlay) {
                context.fillStyle = DisplayPaint.gridStyle(0.25)
                const pairs = fret % 12 === 0 ? [1.5, 3.5] : [2.5]
                pairs.forEach(between => {
                    context.beginPath()
                    context.arc(left + (right - left) * between / (Guitar.Strings - 1), centerY, 2.5 * devicePixelRatio, 0, Math.PI * 2)
                    context.fill()
                })
            }
            if (inlay || (row === 0 && base > 1)) {
                context.fillStyle = row === 0 && base > 1 ? Colors.cream.toString() : Colors.shadow.toString()
                context.fillText(String(fret), right + 4 * devicePixelRatio, centerY)
            }
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
            } else if (fret >= base && fret < base + Frets) {
                context.fillStyle = on ? Colors.white.toString() : DisplayPaint.strokeStyle(0.9)
                context.beginPath()
                context.arc(x, (fretY(fret - base) + fretY(fret - base + 1)) / 2, radius, 0, Math.PI * 2)
                context.fill()
            } else {
                context.fillStyle = on ? Colors.white.toString() : DisplayPaint.strokeStyle(0.9)
                context.beginPath()
                context.arc(x, fret < base ? top : bottom, radius * 0.5, 0, Math.PI * 2)
                context.fill()
            }
        })
    }))
    const moveWindow = (delta: int) => {
        if (!editingShape()) {return}
        edit.base = clamp(edit.base + delta, 1, MaxBase)
        update()
    }
    const toggleFret = (event: PointerEvent) => {
        if (!editingShape() || event.button !== 0 || event.ctrlKey) {return}
        const rect = canvas.getBoundingClientRect()
        const [top, left, right, bottom] = [14, 12, rect.width - 14, rect.height - 4]
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const string = clamp(Math.round((x - left) / (right - left) * (Guitar.Strings - 1)), 0, Guitar.Strings - 1)
        const own = Guitar.unpackShape(shapeField().getValue())
        const tab = (Guitar.isEmptyShape(own) ? shown.tab : own).slice()
        if (y < top + 2) {
            tab[string] = tab[string] < 0 ? 0 : Guitar.Muted
        } else {
            const fret = edit.base + clamp(Math.floor((y - top) / ((bottom - top) / Frets)), 0, Frets - 1)
            tab[string] = tab[string] === fret ? 0 : fret
        }
        editing.modify(() => shapeField().setValue(Guitar.packShape(tab)))
    }
    const write = (element: HTMLElement, text: string) => {
        if (element.textContent !== text) {element.textContent = text}
    }
    const update = () => {
        const tuning = tuningParameter.getControlledValue()
        const position = positionParameter.getControlledValue()
        const keys = mode.getControlledValue() === 1
        const index = chord.getControlledValue()
        if (index !== edit.index) {
            edit.index = index
            edit.base = index > 0 ? fitBase(Guitar.unpackShape(shapeField().getValue())) : 1
        }
        if (keys) {
            name.classList.remove("custom")
            shown.tab = live.frets
            write(name, "Keys")
        } else {
            const own: Nullable<Guitar.Tab> = editingShape() ? Guitar.unpackShape(shapeField().getValue()) : null
            if (isDefined(own) && !Guitar.isEmptyShape(own)) {
                shown.tab = own
                write(name, Guitar.shapeName(own, tuning))
                name.classList.add("custom")
            } else {
                name.classList.remove("custom")
                const current = chordTrack.chordAt(engine.position.getValue())
                shown.tab = current.mapOr(({root, bits}) => {
                    const key = `${root} ${bits} ${tuning} ${position}`
                    if (key !== voicing.key) {
                        voicing.key = key
                        voicing.tab = Guitar.tab(root, bits, tuning, position)
                    }
                    return voicing.tab
                }, new Array<int>(Guitar.Strings).fill(Guitar.Muted))
                write(name, isDefined(own) ? "Empty Shape" : current.mapOr(value => Harmony.chordName(value), "No Chord"))
            }
        }
        shown.lit = live.lit
        if (!keys && !editingShape() && shown.lit !== 0) {
            shown.tab = shown.tab.map((fret, string) => (shown.lit & (1 << string)) !== 0 ? live.frets[string] : fret)
        }
        shown.base = editingShape() ? edit.base : fitBase(shown.tab)
        footer.classList.toggle("editing", editingShape())
        write(footerText, editingShape()
            ? `Frets ${edit.base} to ${edit.base + Frets - 1}`
            : `${Guitar.TuningNames[tuning]} · ${Guitar.PositionNames[position]}`)
        const key = `${shown.tab.join(" ")} ${shown.lit} ${shown.base}`
        if (key !== painted.key) {
            painted.key = key
            painter.requestUpdate()
        }
    }
    lifecycle.ownAll(
        Events.subscribe(canvas, "pointerdown", toggleFret),
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            if (!editingShape()) {return}
            event.preventDefault()
            edit.wheel += event.deltaY
            if (Math.abs(edit.wheel) >= WheelStep) {
                moveWindow(Math.sign(edit.wheel))
                edit.wheel = 0
            }
        }, {passive: false}),
        Events.subscribe(lower, "click", () => moveWindow(-1)),
        Events.subscribe(higher, "click", () => moveWindow(1)),
        chord.subscribe(update),
        ...box.shapes.fields().map(field => field.subscribe(update)),
        engine.position.subscribe(update),
        engine.isPlaying.subscribe(update),
        chordTrack.subscribe(update),
        tuningParameter.subscribe(update),
        positionParameter.subscribe(update),
        mode.subscribe(update),
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
                <div className="selector">{selector}</div>
                {canvas}
                {footer}
            </header>
        </div>
    )
}
