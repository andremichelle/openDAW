import {Nullable, ObservableValue, ValueAxis} from "@opendaw/lib-std"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {EventRadius} from "@/ui/timeline/editors/notes/Constants.ts"
import {PropertyAccessor} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"
import {NoteModifyStrategy} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Capturing, TimelineRange} from "@opendaw/studio-core"

export const createPropertyCapturing = (valueAxis: ValueAxis,
                                        range: TimelineRange,
                                        propertyOwner: ObservableValue<PropertyAccessor>,
                                        owner: NoteEventOwnerReader): Capturing<NoteEventBoxAdapter> => ({
    capture: (x: number, y: number): Nullable<NoteEventBoxAdapter> => {
        const offset = owner.offset
        const local = Math.floor(range.xToUnit(x)) - offset
        const propertyAccessor = propertyOwner.getValue()
        const iterator = owner.content.events
            .iterateRange(local - range.unitsPerPixel * EventRadius, local + range.unitsPerPixel * EventRadius)
        let closest: Nullable<{ event: NoteEventBoxAdapter, distance: number }> = null
        for (const event of iterator) {
            const value = propertyAccessor.valueMapping.x(propertyAccessor.readValue(NoteModifyStrategy.Identity, event))
            const dx = x - range.unitToX(event.position + offset) - 1 // value node is rendered one pixel off
            const dy = y - valueAxis.valueToAxis(value)
            const distance = Math.sqrt(dx * dx + dy * dy)
            if (distance <= EventRadius) {
                if (event.isSelected) {
                    return event
                }
                if (closest === null) {
                    closest = {event, distance}
                } else if (closest.distance < distance) {
                    closest.event = event
                    closest.distance = distance
                }
            }
        }
        return closest?.event ?? null
    }
})