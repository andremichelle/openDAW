import {isDefined, MutableObservableValue, Nullable, Optional, Terminable, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {IconSymbol} from "@opendaw/studio-enums"
import {EffectBox, EffectFactory, Project} from "@opendaw/studio-core"

export namespace CompositeRows {
    export type Zone = "before" | "onto" | "after"
    export type Mark = "insert-before" | "insert-after" | "drop-target"

    export const connectBoolean = (value: MutableObservableValue<boolean>,
                                   wrapper: MutableObservableValue<boolean>): Terminable => {
        value.setValue(wrapper.getValue())
        return Terminable.many(
            value.subscribe(owner => wrapper.setValue(owner.getValue())),
            wrapper.subscribe(owner => value.setValue(owner.getValue()))
        )
    }

    export const effectIcon = (box: Box, factories: Record<string, EffectFactory>): IconSymbol => {
        const factory: Optional<EffectFactory> = factories[box.name.replace(/DeviceBox$/, "").replace(/Box$/, "")]
        return isDefined(factory) ? factory.defaultIcon : IconSymbol.Effects
    }

    export const resolveEffectBoxes = (project: Project, uuids: ReadonlyArray<UUID.String>,
                                       deviceType: "audio-effect" | "midi-effect"): ReadonlyArray<EffectBox> =>
        uuids.flatMap(uuid => project.boxGraph.findBox(UUID.parse(uuid)).match<ReadonlyArray<Box>>({
            none: () => [],
            some: box => [box]
        })).filter((box): box is EffectBox => box.tags.deviceType === deviceType)

    export const zoneOf = (event: DragEvent, element: HTMLElement): Zone => {
        const rect = element.getBoundingClientRect()
        const fraction = (event.clientY - rect.top) / rect.height
        return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "onto"
    }

    export const mark = (element: HTMLElement, active: Nullable<Mark>): void => {
        element.classList.toggle("insert-before", active === "insert-before")
        element.classList.toggle("insert-after", active === "insert-after")
        element.classList.toggle("drop-target", active === "drop-target")
    }
}
