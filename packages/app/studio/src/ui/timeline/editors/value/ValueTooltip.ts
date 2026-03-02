import {Curve, Nullable, Option, StringMapping, Terminable, ValueAxis, ValueMapping} from "@opendaw/lib-std"
import {ValueCaptureTarget} from "@/ui/timeline/editors/value/ValueEventCapturing"
import {Surface} from "@/ui/surface/Surface"
import {ValueModifyStrategy} from "@/ui/timeline/editors/value/ValueModifyStrategies"
import {Events} from "@opendaw/lib-dom"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext"
import {ValueModifier} from "@/ui/timeline/editors/value/ValueModifier"
import {ValueEvent} from "@opendaw/lib-dsp"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"

export namespace ValueTooltip {
    type Creation = {
        element: Element
        capturing: ElementCapturing<ValueCaptureTarget>
        range: TimelineRange
        valueAxis: ValueAxis
        reader: ValueEventOwnerReader
        context: ValueContext
        eventMapping: ValueMapping<number>
        modifyContext: ObservableModifyContext<ValueModifier>
    }

    const stringMapping = StringMapping.percent({unit: "bend", bipolar: true, fractionDigits: 1})

    export const install = (
        {element, capturing, range, valueAxis, reader, context, eventMapping, modifyContext}: Creation): Terminable =>
        Terminable.many(
            Events.subscribe(element, "pointermove", ({clientX, clientY, buttons}: PointerEvent) => {
                if (buttons > 0) {return}
                const target: Nullable<ValueCaptureTarget> = capturing.capturePoint(clientX, clientY)
                if (target?.type === "event") {
                    const event = target.event
                    Surface.get(element).valueTooltip.show(() => {
                        const strategy: Option<ValueModifyStrategy> = modifyContext.modifier
                        const modifier: ValueModifyStrategy = strategy.unwrapOrElse(ValueModifyStrategy.Identity)
                        const clientRect = element.getBoundingClientRect()
                        const clientX = range.unitToX(modifier.readPosition(event) + reader.offset) + clientRect.left + 8
                        const value = modifier.readValue(event)
                        const clientY = valueAxis.valueToAxis(value) + clientRect.top + 8
                        return ({
                            ...context.stringMapping.x(context.valueMapping.y(eventMapping.x(value))),
                            clientX,
                            clientY
                        })
                    })
                } else if (target?.type === "midpoint") {
                    const event = target.event
                    const nextEvent = ValueEvent.nextEvent(reader.content.events, event) ?? event
                    Surface.get(element).valueTooltip.show(() => {
                        const strategy: Option<ValueModifyStrategy> = modifyContext.modifier
                        const modifier: ValueModifyStrategy = strategy.unwrapOrElse(ValueModifyStrategy.Identity)
                        const interpolation = modifier.readInterpolation(event)
                        const slope = interpolation.type !== "curve" ? 0.5 : interpolation.slope
                        const midPosition = (modifier.readPosition(event) + modifier.readPosition(nextEvent)) * 0.5
                        const y0 = valueAxis.valueToAxis(modifier.readValue(event))
                        const y1 = valueAxis.valueToAxis(modifier.readValue(nextEvent))
                        const midY = Curve.normalizedAt(0.5, slope) * (y1 - y0) + y0
                        const clientRect = element.getBoundingClientRect()
                        const clientX = range.unitToX(midPosition + reader.offset) + clientRect.left + 8
                        const clientY = midY + clientRect.top + 8
                        return ({...stringMapping.x(slope), clientX, clientY})
                    })
                } else {
                    Surface.get(element).valueTooltip.hide()
                }
            }),
            Events.subscribe(element, "pointerleave", () => Surface.get(element).valueTooltip.hide())
        )
}