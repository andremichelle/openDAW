import {Dragging} from "@opendaw/lib-dom"

export interface Modifier {
    update(event: Dragging.Event): void
    approve(): void
    cancel(): void
}