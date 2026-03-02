import css from "./PianoRoll.sass?inline"
import {int, Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"
import {MidiKeys} from "@opendaw/lib-dsp"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {NoteSignal, NoteStreamReceiver} from "@opendaw/studio-adapters"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {Fonts} from "@/ui/Fonts"
import {CanvasPainter, CaptureMidi} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "PianoRoll")

type Construct = {
    lifecycle: Lifecycle
    positioner: PitchPositioner
    scale: ScaleConfig
    noteReceiver: NoteStreamReceiver
    capture: CaptureMidi
}

export const PianoRoll = ({lifecycle, positioner, scale, noteReceiver, capture}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const canvasPainter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const context = painter.context
        const {canvas: {width}} = context
        const pitchToY = (pitch: int) => positioner.pitchToY(pitch) * devicePixelRatio
        context.textBaseline = "middle"
        context.textAlign = "right"
        const fontSize = positioner.noteHeight * 0.95 * devicePixelRatio
        context.font = `${fontSize}px ${Fonts.Rubik["font-family"]}, sans-serif`
        const topNote = positioner.yToPitch(0)
        const bottomNote = positioner.yToPitch(canvas.clientHeight)
        const noteTrackHeight = (positioner.noteHeight - 1) * devicePixelRatio
        for (let note = bottomNote; note <= topNote; note++) {
            const noteToY = pitchToY(note)
            context.fillStyle = MidiKeys.isBlackKey(note) ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.5)"
            context.fillRect(0, noteToY, width, noteTrackHeight)
            if (!scale.has(note)) {
                context.fillStyle = "rgb(192, 64, 64)"
                context.fillRect(width - devicePixelRatio * 3, noteToY, devicePixelRatio * 3, noteTrackHeight)
            }
            if (noteReceiver.isNoteOn(note)) {
                context.fillStyle = Colors.blue.toString()
                context.fillRect(0, noteToY, width, noteTrackHeight)
            }
        }
        context.fillStyle = "rgba(0, 0, 0, 0.66)"
        for (let note = bottomNote; note <= topNote; note++) {
            if (note % 12 === 0) {
                const noteToY = pitchToY(note)
                const label = MidiKeys.toFullString(note)
                context.fillText(label, width - devicePixelRatio * 2, noteToY + noteTrackHeight / 2 + 1)
            }
        }
    }))
    const element = <div className={className}>{canvas}</div>
    lifecycle.ownAll(
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            positioner.scrollModel.moveBy(event.deltaY)
        }, {passive: false}),
        Dragging.attach(canvas, ({clientY}) => {
            let pitch = positioner.yToPitch(clientY - canvas.getBoundingClientRect().top)
            capture.notify(NoteSignal.on(capture.uuid, pitch, 1.0))
            return Option.wrap({
                update: ({clientY}: Dragging.Event) => {
                    const newPitch = positioner.yToPitch(clientY - canvas.getBoundingClientRect().top)
                    if (pitch !== newPitch) {
                        capture.notify(NoteSignal.off(capture.uuid, pitch))
                        pitch = newPitch
                        capture.notify(NoteSignal.on(capture.uuid, pitch, 1.0))
                    }
                },
                finally: () => capture.notify(NoteSignal.off(capture.uuid, pitch))
            })
        }),
        scale.subscribe(() => canvasPainter.requestUpdate()),
        positioner.subscribe(() => canvasPainter.requestUpdate()),
        noteReceiver.subscribe(() => canvasPainter.requestUpdate()),
        Html.watchResize(element, () => canvasPainter.requestUpdate())
    )
    return element
}