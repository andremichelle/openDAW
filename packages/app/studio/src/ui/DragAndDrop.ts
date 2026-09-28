import {
    Arrays,
    Client,
    InaccessibleProperty,
    int,
    isDefined,
    Nullable,
    Option,
    Provider,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {AnyDragData, DragFile} from "@/ui/AnyDragData"
import {Events} from "@opendaw/lib-dom"

export namespace DragAndDrop {
    let dragging: Option<AnyDragData> = Option.None
    // One drag at a time: document-level listeners that end it even when the source left the DOM meanwhile
    // (Chrome fires no dragend on a removed source, e.g. a device editor rebuilt by the hover switch).
    const session = new Terminator()

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

    // A provider returning null VETOES the drag: no native drag starts (no ghost), no state is touched.
    export const installSource = (element: HTMLElement,
                                  provider: Provider<Nullable<AnyDragData>>,
                                  classReceiver?: Element,
                                  dragImage?: Provider<HTMLElement>): Terminable => {
        classReceiver ??= element
        element.draggable = true
        let activeImage: Nullable<HTMLElement> = null
        const end = () => {
            classReceiver.classList.remove("dragging")
            dragging = Option.None
            if (isDefined(activeImage)) {
                activeImage.remove()
                activeImage = null
            }
            session.terminate()
        }
        return Terminable.many(
            Events.subscribe(element, "dragend", end),
            Events.subscribe(element, "dragstart",
                (event: DragEvent) => {
                    const dataTransfer = event.dataTransfer
                    if (!isDefined(dataTransfer)) {return}
                    const data = provider()
                    if (!isDefined(data)) {
                        event.preventDefault()
                        return
                    }
                    dataTransfer.setData("application/json", "{custom: true}")
                    dataTransfer.effectAllowed = "copyMove"
                    classReceiver.classList.add("dragging")
                    dragging = Option.wrap(data)
                    const owner = element.ownerDocument
                    let begun = false // no pointer event reaches the page while a drag runs, so one after means it ended
                    session.terminate()
                    session.ownAll(
                        Events.subscribe(owner, "dragover", () => begun = true, {capture: true}),
                        Events.subscribe(owner, "dragend", end, {capture: true}),
                        Events.subscribe(owner, "drop", end),
                        Events.subscribe(owner, "pointermove", () => {if (begun) {end()}}, {capture: true}),
                        Events.subscribe(owner, "pointerdown", () => {if (begun) {end()}}, {capture: true})
                    )
                    if (isDefined(dragImage)) {
                        const ghost = dragImage()
                        ghost.style.position = "fixed"
                        ghost.style.top = "-9999px"
                        ghost.style.left = "-9999px"
                        ghost.style.pointerEvents = "none"
                        document.body.appendChild(ghost)
                        dataTransfer.setDragImage(ghost, 0, 0)
                        activeImage = ghost
                    }
                })
        )
    }

    export const isCopy = (event: DragEvent, data: AnyDragData): boolean => event.altKey || data.copy === true

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
                            files: InaccessibleProperty("Cannot access files while dragging")
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
                            files: InaccessibleProperty("Cannot access files while dragging")
                        })) {
                            event.preventDefault()
                            dataTransfer.dropEffect = "copy"
                        }
                    },
                    some: data => {
                        if (process.drag(event, data)) {
                            event.preventDefault()
                            dataTransfer.dropEffect = isCopy(event, data) ? "copy" : "move"
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
                        const data: DragFile = {type: "file", files}
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

    // The vertical sibling of `findInsertLocation`. Skips hidden entries (an empty, display-none container
    // would land at y 0 and shift every index) and sorts by the on-screen top edge, so it also serves
    // containers whose children are grid-placed (DOM order differs from display order).
    export const findInsertLocationVertical = ({clientY}: Client, parent: Element, limit?: [int, int]): [int, Nullable<Element>] => {
        const elements = Array.from(parent.querySelectorAll("[data-drag]"))
            .filter(candidate => candidate.getClientRects().length > 0)
            .toSorted((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        const [minIndex, maxIndex] = limit ?? [0, elements.length]
        let index: int = minIndex
        while (true) {
            const child = elements[index] ?? null
            if (index >= maxIndex) {return [index, child]}
            const rect = child.getBoundingClientRect()
            const center = (rect.top + rect.bottom) / 2
            if (clientY < center) {return [index, child]}
            index++
        }
    }
}