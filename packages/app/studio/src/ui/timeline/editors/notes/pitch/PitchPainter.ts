import {int, linear, Option, Procedure} from "@opendaw/lib-std"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {MidiKeys, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifyStrategies, NoteModifyStrategy} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {renderTimeGrid} from "@/ui/timeline/editors/TimeGridRenderer.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"

type Construct = {
    canvas: HTMLCanvasElement,
    positioner: PitchPositioner,
    scale: ScaleConfig,
    range: TimelineRange,
    snapping: Snapping,
    modifyContext: ObservableModifyContext<NoteModifier>,
    reader: NoteEventOwnerReader
}

export const createNotePitchPainter =
    ({canvas, positioner, scale, range, snapping, modifyContext, reader}: Construct): Procedure<CanvasPainter> =>
        painter => {
            const {context} = painter
            const {canvas: {width, height}} = context
            const unitToX = (unit: ppqn) => Math.floor(range.unitToX(unit + reader.offset) * devicePixelRatio)
            const pitchToY = (pitch: int) => positioner.pitchToY(pitch) * devicePixelRatio
            renderTimeGrid(context, reader.timelineBoxAdapter.signatureTrack, range, snapping, 0, height)
            const modifier: Option<NoteModifyStrategies> = modifyContext.modifier
            const strategy = modifier.unwrapOrElse(NoteModifyStrategies.Identity)
            // LOOP DURATION
            const x0 = unitToX(0)
            const x1 = unitToX(strategy.readContentDuration(reader))
            if (x0 > 0) {
                context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.30)`
                context.fillRect(x0, 0, devicePixelRatio, height)
            }
            if (x1 > 0) {
                context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.03)`
                context.fillRect(x0, 0, x1 - x0, height)
                context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.30)`
                context.fillRect(x1, 0, devicePixelRatio, height)
            }
            const noteHeight = (positioner.noteHeight - 1) * devicePixelRatio
            const noteOutlineHeight = (positioner.noteHeight + 1) * devicePixelRatio
            // NOTE ROWS
            const topNote = positioner.yToPitch(0)
            const bottomNote = positioner.yToPitch(canvas.clientHeight)
            for (let note = bottomNote; note <= topNote; note++) {
                if (scale.has(note)) {
                    context.fillStyle = MidiKeys.isBlackKey(note) ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.02)"
                    context.fillRect(0, pitchToY(note), width, noteHeight)
                } else {
                    context.fillStyle = "rgba(255, 128, 128, 0.08)"
                    context.fillRect(0, pitchToY(note), width, noteHeight)
                }
            }
            // NOTES
            const unitMin = range.unitMin - range.unitPadding - reader.offset
            const unitMax = range.unitMax - reader.offset
            const eventCollection = reader.content
            const render = (strategy: NoteModifyStrategy, filterSelected: boolean, hideSelected: boolean) => {
                for (const noteEvent of strategy
                    .iterateRange(eventCollection.events, unitMin - eventCollection.maxDuration, unitMax)) {
                    if (noteEvent.isSelected ? hideSelected : !filterSelected) {continue}
                    const selected = noteEvent.isSelected && !filterSelected
                    const position = strategy.readPosition(noteEvent)
                    const complete = strategy.readComplete(noteEvent)
                    const pitch = strategy.readPitch(noteEvent)
                    const x0 = unitToX(position)
                    const x1 = unitToX(complete)
                    const y0 = pitchToY(pitch)
                    const xn = Math.max(x1 - x0, 3) // ensure that the note color is coming through the outline
                    context.fillStyle = selected ? "white" : "black"
                    context.fillRect(x0, y0 - devicePixelRatio, xn + devicePixelRatio, noteOutlineHeight)
                    const w = xn - devicePixelRatio
                    if (w > 0) {
                        const saturation = strategy.readChance(noteEvent) * 0.50
                        const opacity = linear(33, 100, strategy.readVelocity(noteEvent) ** 2.0)
                        context.fillStyle = `hsla(${reader.hue}, ${saturation}%, 50%, ${opacity}%)`
                        context.fillRect(x0 + devicePixelRatio, y0, w, noteHeight)
                    }
                    const ftRange = noteHeight >>> 1
                    const ft = strategy.readCent(noteEvent) / 50.0 * (ftRange - devicePixelRatio * 2)
                    context.fillStyle = selected ? "rgba(255, 255, 255, 0.75)" : "rgba(0, 0, 0, 0.5)"
                    const y = y0 + ftRange - ft - 1
                    const playCount = noteEvent.playCount
                    const playCurve = noteEvent.playCurve
                    const duration = complete - position
                    for (let cycle = 0; cycle < playCount; cycle++) {
                        const b0 = NoteEvent.curveFunc(cycle / playCount, playCurve)
                        const b1 = NoteEvent.curveFunc((cycle + 1) / playCount, playCurve)
                        const cx0 = Math.max(unitToX(position + duration * b0), x0 + devicePixelRatio)
                        const cx1 = Math.min(unitToX(position + duration * b1), x1 - devicePixelRatio)
                        context.fillRect(cx0 + devicePixelRatio, y, cx1 - cx0 - devicePixelRatio, devicePixelRatio)
                    }
                }
            }
            const unselectedStrategy = strategy.unselectedModifyStrategy()
            const selectedStrategy = strategy.selectedModifyStrategy()
            render(unselectedStrategy, true, !strategy.showOrigin())
            render(selectedStrategy, false, false)

            // painting the notes on the scroller track
            //
            const left = width - 5 * devicePixelRatio
            const bottom = painter.actualHeight - devicePixelRatio
            const scrollerWidth = 2 * devicePixelRatio

            context.fillStyle = `hsl(${reader.hue}, 50%, 50%)`
            for (const event of eventCollection.events.asArray()) {
                if (event.isSelected) {continue}
                const ny = (1.0 - unselectedStrategy.readPitch(event) / 127) * bottom
                context.fillRect(left, ny, scrollerWidth, devicePixelRatio)
            }

            context.fillStyle = "white"
            for (const event of eventCollection.events.asArray()) {
                if (!event.isSelected) {continue}
                const ny = (1.0 - selectedStrategy.readPitch(event) / 127) * bottom
                context.fillRect(left, ny, scrollerWidth, devicePixelRatio)
            }
        }