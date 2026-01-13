import {Dragging} from "@moises-ai/lib-dom"
import {BoxEditing} from "@moises-ai/lib-box"

export interface Modifier {
    update(event: Dragging.Event): void
    approve(editing: BoxEditing): void
    cancel(): void
}