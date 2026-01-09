import {
    Arrays,
    Client,
    InaccessibleProperty,
    int,
    isDefined,
    Nullable,
    Option,
    Provider,
    Terminable
} from "@opendaw/lib-std"
import {AnyDragData, DragFile} from "@/ui/AnyDragData"
import {Events} from "@opendaw/lib-dom"

export namespace DragAndDrop {
    let dragging: Option<AnyDragData> = Option.None

    const hasFiles = (event: DragEvent): boolean => {
        const type = event.dataTransfer?.types?.at(0)
        return type === "Files" || type === "application/x-moz-file"
    }

    const extractFiles = (event: DragEvent): ReadonlyArray<File> => {
        const dataTransfer = event.dataTransfer
        if (!isDefined(dataTransfer)) {return Arrays.empty()}
        if (hasFiles(event)) {
            return Array.from(dataTransfer.files)
        }
        return Arrays.empty()
    }

    export const installSource = (element: HTMLElement, provider: Provider<AnyDragData>, classReceiver?: Element): Terminable => {
        classReceiver ??= element
        element.draggable = true
        return Terminable.many(
            Events.subscribe(element, "dragend", () => {
                classReceiver.classList.remove("dragging")
                dragging = Option.None
            }),
            Events.subscribe(element, "dragstart",
                (event: DragEvent) => {
                    const dataTransfer = event.dataTransfer
                    if (!isDefined(dataTransfer)) {return}
                    dataTransfer.setData("application/json", "{custom: true}")
                    dataTransfer.effectAllowed = "copyMove"
                    classReceiver.classList.add("dragging")
                    dragging = Option.wrap(provider())
                })
        )
    }

    export interface Process {
        drag(event: DragEvent, dragData: AnyDragData): boolean
        drop(event: DragEvent, dragData: AnyDragData): void
        enter(allowDrop: boolean): void
        leave(): void
    }

    export const installTarget = (element: HTMLElement, process: Process): Terminable => {
        let count: int = 0 | 0
        return Terminable.many(
            Events.subscribe(element, "dragenter", (event: DragEvent) => {
                if (count++ === 0) {
                    process.enter(dragging.match({
                        none: () => hasFiles(event) && process.drag(event, {
                            type: "file",
                            file: InaccessibleProperty("Cannot access file while dragging")
                        }),
                        some: data => process.drag(event, data)
                    }))
                }
            }),
            Events.subscribe(element, "dragover", (event: DragEvent) => {
                const dataTransfer = event.dataTransfer
                if (!isDefined(dataTransfer)) {return}
                dragging.match({
                    none: () => {
                        if (hasFiles(event) && process.drag(event, {
                            type: "file",
                            file: InaccessibleProperty("Cannot access file while dragging")
                        })) {
                            event.preventDefault()
                            dataTransfer.dropEffect = "copy"
                        }
                    },
                    some: data => {
                        if (process.drag(event, data)) {
                            event.preventDefault()
                            dataTransfer.dropEffect = event.altKey || data.copy === true ? "copy" : "move"
                        }
                    }
                })
            }),
            Events.subscribe(element, "dragleave", (_event: DragEvent) => {
                if (--count === 0) {process.leave()}
            }),
            Events.subscribe(element, "drop", (event: DragEvent) => {
                dragging.match({
                    none: () => {
                        const files = extractFiles(event)
                        if (files.length === 0) {return}
                        const data: DragFile = {type: "file", file: files[0]}
                        if (process.drag(event, data)) {
                            event.preventDefault()
                            process.drop(event, data)
                            dragging = Option.None
                        }
                    },
                    some: data => {
                        if (process.drag(event, data)) {
                            event.preventDefault()
                            process.drop(event, data)
                            dragging = Option.None
                        }
                    }
                })
                if (count > 0) {
                    process.leave()
                    count = 0
                }
            }),
            Events.subscribe(element, "dragend", (_event: DragEvent) => count = 0, {capture: true})
        )
    }

    export const findInsertLocation = ({clientX}: Client, parent: Element, limit?: [int, int]): [int, Nullable<Element>] => {
        const elements = Array.from(parent.querySelectorAll("[data-drag]"))
        const [minIndex, maxIndex] = limit ?? [0, elements.length]
        let index: int = minIndex
        while (true) {
            const child = elements[index] ?? null
            if (index >= maxIndex) {return [index, child]}
            const rect = child.getBoundingClientRect()
            const center = (rect.left + rect.right) / 2
            if (clientX < center) {return [index, child]}
            index++
        }
    }
}