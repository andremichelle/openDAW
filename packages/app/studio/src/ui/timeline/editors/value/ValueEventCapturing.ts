import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {Arrays, Curve, Func, isDefined, Nullable, unitValue} from "@opendaw/lib-std"
import {ValueEventBoxAdapter} from "@opendaw/studio-adapters"
import {ValueEvent} from "@opendaw/lib-dsp"
import {EventRadius, MidPointRadius} from "./Constants"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {TimelineRange} from "@opendaw/studio-core"

export type ValueCaptureTarget =
    | { type: "event", event: ValueEventBoxAdapter }
    | { type: "midpoint", event: ValueEventBoxAdapter }
    | { type: "loop-duration", reader: ValueEventOwnerReader }

export const createValueEventCapturing = (element: Element,
                                          range: TimelineRange,
                                          valueToY: Func<unitValue, number>,
                                          reader: ValueEventOwnerReader) => {

    const captureEvent = (x: number, y: number): Nullable<ValueCaptureTarget> => {
        const events = reader.content.events
        if (events.length() === 0) {return null}
        const {offset} = reader
        const p = Math.floor(range.xToUnit(x)) - offset
        const radiusInUnits = range.unitsPerPixel * EventRadius
        const withinRadius = ValueEvent
            .iterateWindow<ValueEventBoxAdapter>(events, p - radiusInUnits, p + radiusInUnits)
        let closest: Nullable<{ event: ValueEventBoxAdapter, distance: number }> = null
        for (const event of withinRadius) {
            const dx = x - range.unitToX(offset + event.position)
            const dy = y - valueToY(event.value)
            const distance = Math.sqrt(dx * dx + dy * dy)
            if (distance <= EventRadius) {
                if (closest === null) {
                    closest = {event, distance}
                } else if (closest.distance < distance) {
                    closest.event = event
                    closest.distance = distance
                }
            }
        }
        if (closest !== null) {return {type: "event", event: closest.event}}
        const index = events.floorLastIndex(p)
        const array = events.asArray()
        if (index === -1) {
            const first = Arrays.getFirst(array, "Internal Error")
            if (Math.abs(valueToY(first.value) - y) < PointerRadiusDistance) {
                return {type: "event", event: first}
            }
        } else if (index === events.length() - 1) {
            return null
        } else {
            const n0 = array[index]
            const interpolation = n0.interpolation
            if (interpolation.type === "none") {
                return null
            }
            const n1 = array[index + 1]
            const slope = interpolation.type === "curve" ? interpolation.slope : 0.5
            const midX = range.unitToX(offset + (n0.position + n1.position) * 0.5)
            const midY = valueToY(Curve.normalizedAt(0.5, slope) * (n1.value - n0.value) + n0.value)
            const dx = x - midX
            const dy = y - midY
            if (Math.sqrt(dx * dx + dy * dy) <= MidPointRadius) {
                return {type: "midpoint", event: n0}
            }
        }
        return null
    }

    return new ElementCapturing<ValueCaptureTarget>(element, {
        capture: (x: number, y: number): Nullable<ValueCaptureTarget> => {
            const event = captureEvent(x, y)
            return isDefined(event)
                ? event
                : Math.abs(range.unitToX(reader.loopDuration + reader.offset) - x) < PointerRadiusDistance
                    ? {type: "loop-duration", reader}
                    : null
        }
    })
}