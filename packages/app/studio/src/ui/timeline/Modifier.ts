import {Dragging} from "@moises-ai/lib-dom"

export interface Modifier {
    update(event: Dragging.Event): void
    approve(): void
    cancel(): void
}