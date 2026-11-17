import css from "./FretDisplay.sass?inline"
import {clamp, int, isDefined, Lifecycle, Nullable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Guitar, Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {GuitarDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, ContextMenu, MenuItem, Project} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "GuitarFretDisplay")

const Frets = 5
const MaxBase = Guitar.MaxFret - Frets + 1
const WheelStep = 40
const Inlays: ReadonlyArray<int> = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]
const Margin = {top: 14, left: 12, right: 14, bottom: 13}
const DragStep = 6
// WASM CONTRACT: `AUDITION_FIELD` in device-guitar, `pitch << 3 | string` plucks one string, -1 lets go
const AuditionKey = 46

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
    const shown = {tab: new Array<int>(Guitar.Strings).fill(Guitar.Muted) as ReadonlyArray<int>, lit: 0, base: 1,
        open: Guitar.Tunings[0], custom: false}
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
        const {tab, lit, base, open, custom} = shown
        const top = Margin.top * devicePixelRatio
        const left = Margin.left * devicePixelRatio
        const right = actualWidth - Margin.right * devicePixelRatio
        const bottom = actualHeight - Margin.bottom * devicePixelRatio
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
        context.textAlign = "center"
        context.textBaseline = "middle"
        context.font = `${7 * devicePixelRatio}px Rubik, sans-serif`
        open.forEach((note, string) => {
            context.fillStyle = custom ? Colors.orange.toString() : Colors.shadow.toString()
            context.fillText(note === Guitar.Off ? "–" : MidiKeys.toFullString(note), stringX(string), actualHeight - 5 * devicePixelRatio)
        })
        context.font = `${9 * devicePixelRatio}px Rubik, sans-serif`
        tab.forEach((fret, string) => {
            const on = (lit & (1 << string)) !== 0
            const x = stringX(string)
            const off = open[string] === Guitar.Off
            context.lineWidth = (0.8 + (Guitar.Strings - 1 - string) * 0.2) * devicePixelRatio
            context.strokeStyle = on ? DisplayPaint.strokeStyle(1.0) : DisplayPaint.gridStyle(off ? 0.12 : 0.5)
            context.beginPath()
            context.moveTo(x, top)
            context.lineTo(x, bottom)
            context.stroke()
            const markY = top - 7 * devicePixelRatio
            if (off) {
                return
            } else if (fret < 0) {
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
    const locate = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect()
        const [left, right] = [Margin.left, rect.width - Margin.right]
        const string = clamp(Math.round((clientX - rect.left - left) / (right - left) * (Guitar.Strings - 1)), 0, Guitar.Strings - 1)
        return {string, y: clientY - rect.top, bottom: rect.height - Margin.bottom, strip: clientY - rect.top > rect.height - Margin.bottom}
    }
    const tuneString = (string: int, note: int, mark: boolean): boolean => {
        const open = adapter.openStrings()
        if (open[string] === note) {return false}
        editing.modify(() => {
            open.forEach((value, index) => box.notes.getField(index).setValue(index === string ? note : value))
            if (tuningParameter.getValue() !== Guitar.Custom) {tuningParameter.setValue(Guitar.Custom)}
        }, mark)
        return true
    }
    const drag = lifecycle.own(new Terminator())
    const startTuning = (event: PointerEvent) => {
        const {string, strip} = locate(event.clientX, event.clientY)
        if (!strip || event.button !== 0 || event.ctrlKey) {return false}
        const start = adapter.openStrings()[string]
        if (start === Guitar.Off) {return true}
        const finger = Math.max(0, shown.tab[string])
        const pluck = (pitch: int) => engine.overrideDeviceField(adapter.uuid, AuditionKey, pitch << 3 | string)
        let mark = true
        let sounding = start + finger
        drag.terminate()
        pluck(sounding)
        drag.ownAll(
            Events.subscribe(window, "pointermove", (moveEvent: PointerEvent) => {
                const note = clamp(start + Math.round((event.clientY - moveEvent.clientY) / DragStep), Guitar.LowestNote, Guitar.HighestNote)
                if (tuneString(string, note, mark)) {mark = false}
                if (note + finger !== sounding) {
                    sounding = note + finger
                    pluck(sounding)
                }
            }),
            Events.subscribe(window, "pointerup", () => drag.terminate()),
            {terminate: () => engine.overrideDeviceField(adapter.uuid, AuditionKey, -1)})
        return true
    }
    const toggleFret = (event: PointerEvent) => {
        if (startTuning(event)) {return}
        if (!editingShape() || event.button !== 0 || event.ctrlKey) {return}
        const {string, y, bottom} = locate(event.clientX, event.clientY)
        if (shown.open[string] === Guitar.Off) {return}
        const top = Margin.top
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
        const open = adapter.openStrings()
        shown.open = open
        shown.custom = tuning === Guitar.Custom
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
                write(name, Guitar.shapeName(own, open))
                name.classList.add("custom")
            } else {
                name.classList.remove("custom")
                const current = chordTrack.chordAt(engine.position.getValue())
                shown.tab = current.mapOr(({root, bits}) => {
                    const key = `${root} ${bits} ${open.join(" ")} ${position}`
                    if (key !== voicing.key) {
                        voicing.key = key
                        voicing.tab = Guitar.tab(root, bits, open, position)
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
        const key = `${shown.tab.join(" ")} ${shown.lit} ${shown.base} ${open.join(" ")} ${shown.custom}`
        if (key !== painted.key) {
            painted.key = key
            painter.requestUpdate()
        }
    }
    lifecycle.ownAll(
        Events.subscribe(canvas, "pointerdown", toggleFret),
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            const {string, strip} = locate(event.clientX, event.clientY)
            const note = adapter.openStrings()[string]
            const tuning = strip && note !== Guitar.Off
            if (!tuning && !editingShape()) {return}
            event.preventDefault()
            edit.wheel += event.deltaY
            if (Math.abs(edit.wheel) >= WheelStep) {
                if (tuning) {
                    tuneString(string, clamp(note - Math.sign(edit.wheel), Guitar.LowestNote, Guitar.HighestNote), true)
                } else {
                    moveWindow(Math.sign(edit.wheel))
                }
                edit.wheel = 0
            }
        }, {passive: false}),
        ContextMenu.subscribe(canvas, collector => {
            const {string, strip} = locate(collector.client.clientX, collector.client.clientY)
            if (!strip) {return}
            const open = adapter.openStrings()
            const off = open[string] === Guitar.Off
            const last = open.filter(note => note !== Guitar.Off).length === 1
            collector.addItems(
                MenuItem.default({label: off ? "String On" : "String Off", selectable: off || !last})
                    .setTriggerProcedure(() => tuneString(string, off ? Guitar.Tunings[0][string] : Guitar.Off, true)),
                ...Guitar.TuningNames.slice(0, Guitar.Custom).map((label, index) => MenuItem.default({
                    label: `Copy ${label}`, separatorBefore: index === 0
                }).setTriggerProcedure(() => editing.modify(() => {
                    Guitar.Tunings[index].forEach((value, which) => box.notes.getField(which).setValue(value))
                    tuningParameter.setValue(Guitar.Custom)
                }))))
        }),
        Events.subscribe(lower, "click", () => moveWindow(-1)),
        Events.subscribe(higher, "click", () => moveWindow(1)),
        chord.subscribe(update),
        ...box.shapes.fields().map(field => field.subscribe(update)),
        ...box.notes.fields().map(field => field.subscribe(update)),
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
