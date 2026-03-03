import {Arrays, ObservableValue, Option, Procedure, ValueAxis} from "@opendaw/lib-std"
import {PropertyNodeSize} from "@/ui/timeline/editors/notes/Constants.ts"
import {renderTimeGrid} from "@/ui/timeline/editors/TimeGridRenderer.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {PropertyAccessor} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteModifyStrategies, NoteModifyStrategy} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"

type Construct = {
    canvas: HTMLCanvasElement,
    range: TimelineRange,
    snapping: Snapping,
    valueAxis: ValueAxis,
    propertyOwner: ObservableValue<PropertyAccessor>
    modifyContext: ObservableModifyContext<NoteModifier>
    reader: NoteEventOwnerReader
}

export const createPropertyPainter =
    ({range, valueAxis, propertyOwner, snapping, modifyContext, reader}: Construct): Procedure<CanvasPainter> =>
        painter => {
            const context = painter.context
            renderTimeGrid(context, reader.timelineBoxAdapter.signatureTrack, range, snapping,
                Math.floor(valueAxis.valueToAxis(1.0) * devicePixelRatio),
                Math.floor(valueAxis.valueToAxis(0.0) * devicePixelRatio))
            const {offset, hue, content: {events}} = reader
            const unitMin = range.unitMin - offset - range.unitPadding
            const unitMax = range.unitMax - offset
            const propertyAccessor = propertyOwner.getValue()
            const {valueMapping, anchor} = propertyAccessor
            const modifier: Option<NoteModifyStrategies> = modifyContext.modifier
            const strategies = modifier.unwrapOrElse(NoteModifyStrategies.Identity)
            const anchorY = Math.floor(valueAxis.valueToAxis(anchor) * devicePixelRatio)
            if (anchor !== 0.0) {
                context.beginPath()
                context.setLineDash([4, 2])
                context.strokeStyle = `hsla(${hue}, 50%, 50%, 0.25)`
                context.moveTo(0, anchorY)
                context.lineTo(painter.actualWidth, anchorY)
                context.stroke()
                context.setLineDash(Arrays.empty())
            }
            strategies.showPropertyLine()
                .ifSome(([{u: u0, v: v0}, {u: u1, v: v1}]) => {
                    const x0 = range.unitToX(u0) * devicePixelRatio
                    const x1 = range.unitToX(u1) * devicePixelRatio
                    const y0 = valueAxis.valueToAxis(v0) * devicePixelRatio
                    const y1 = valueAxis.valueToAxis(v1) * devicePixelRatio
                    context.beginPath()
                    context.strokeStyle = "white"
                    context.moveTo(x0, y0)
                    context.lineTo(x1, y1)
                    context.stroke()
                })
            const render = (strategy: NoteModifyStrategy, filterSelected: boolean) => {
                for (const event of events.iterateRange(unitMin, unitMax)) {
                    if (event.isSelected === filterSelected) {continue}
                    const position = strategy.readPosition(event)
                    const value = propertyAccessor.readValue(strategy, event)
                    const x = Math.floor(range.unitToX(position + offset) * devicePixelRatio)
                    const y = Math.floor(valueAxis.valueToAxis(valueMapping.x(value)) * devicePixelRatio)
                    context.fillRect(x, y - devicePixelRatio * 2, PropertyNodeSize * devicePixelRatio, PropertyNodeSize * devicePixelRatio)
                    context.fillRect(x, Math.min(y, anchorY), devicePixelRatio, Math.abs(y - anchorY))
                }
            }
            context.fillStyle = `hsl(${hue}, 50%, 50%)`
            render(strategies.unselectedModifyStrategy(), true)
            context.fillStyle = "white"
            render(strategies.selectedModifyStrategy(), false)
        }