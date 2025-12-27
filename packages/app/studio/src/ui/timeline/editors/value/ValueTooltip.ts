import {Curve, Nullable, Option, StringMapping, Terminable, ValueAxis, ValueMapping} from "@opendaw/lib-std"
import {ValueCaptureTarget} from "@/ui/timeline/editors/value/ValueEventCapturing"
import {Surface} from "@/ui/surface/Surface"
import {ValueModifyStrategy} from "@/ui/timeline/editors/value/ValueModifyStrategies"
import {Events} from "@opendaw/lib-dom"
import {ElementCapturing} from "@/ui/canvas/capturing"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext"
import {ValueModifier} from "@/ui/timeline/editors/value/ValueModifier"
import {ValueEvent} from "@opendaw/lib-dsp"
import {TimelineRange} from "@opendaw/studio-core"
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
                        const stringMapping = StringMapping.numeric({unit: "bend", bipolar: true, fractionDigits: 3})
                        const strategy: Option<ValueModifyStrategy> = modifyContext.modifier
                        const modifier: ValueModifyStrategy = strategy.unwrapOrElse(ValueModifyStrategy.Identity)
                        const interpolation = modifier.readInterpolation(event)
                        const slope = interpolation.type !== "curve" ? 0.5 : interpolation.slope
                        const v0 = modifier.readValue(event)
                        const v1 = modifier.readValue(nextEvent)
                        const midPosition = (modifier.readPosition(event) + modifier.readPosition(nextEvent)) * 0.5
                        const midValue = Curve.normalizedAt(0.5, slope) * (v1 - v0) + v0
                        const clientRect = element.getBoundingClientRect()
                        const clientX = range.unitToX(midPosition + reader.offset) + clientRect.left + 8
                        const clientY = valueAxis.valueToAxis(midValue) + clientRect.top + 8
                        return ({...stringMapping.x(slope), clientX, clientY})
                    })
                } else {
                    Surface.get(element).valueTooltip.hide()
                }
            }),
            Events.subscribe(element, "pointerleave", () => Surface.get(element).valueTooltip.hide())
        )
}