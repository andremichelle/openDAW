import {int, Lifecycle, Option, Optional, tryCatch, UUID} from "@opendaw/lib-std"
import {PointerField, PointerHub} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ClipboardEntry, ClipboardManager} from "@opendaw/studio-core"

/** A device pattern on the studio clipboard as JSON, its groove by uuid so it only returns into the same project. */
export namespace PatternClipboard {
    export const encode = <T>(type: string, value: T): ClipboardEntry =>
        ({type, data: new TextEncoder().encode(JSON.stringify(value)).buffer, count: 1})

    export const decode = <T>(type: string, entry: ClipboardEntry): Option<T> => {
        if (entry.type !== type) {return Option.None}
        const {status, value} = tryCatch(() => JSON.parse(new TextDecoder().decode(entry.data)) as T)
        return status === "success" ? Option.wrap(value) : Option.None
    }

    export const grooveOf = (pointer: PointerField<Pointers.Groove>): Optional<UUID.String> =>
        pointer.targetVertex.mapOr(({box}) => UUID.toString(box.address.uuid), undefined)

    export const referGroove = (pointer: PointerField<Pointers.Groove>, groove: Optional<UUID.String>): void =>
        Option.wrap(groove).flatMap(uuid => pointer.graph.findBox(UUID.parse(uuid)))
            .flatMap(target => PointerHub.validate(pointer, target).isEmpty() ? Option.wrap(target) : Option.None)
            .match({none: () => pointer.defer(), some: target => pointer.refer(target)})

    /** Cmd+C and Cmd+V on the focused tile of `tiles` copy and paste its pattern. */
    export const install = (lifecycle: Lifecycle, element: HTMLElement, type: string, tiles: ReadonlyArray<HTMLElement>,
                            copy: (index: int) => ClipboardEntry, paste: (index: int, entry: ClipboardEntry) => void): void => {
        const focused = (): Option<int> => {
            const index = tiles.findIndex(tile => tile === document.activeElement)
            return index >= 0 ? Option.wrap(index) : Option.None
        }
        lifecycle.own(ClipboardManager.install(element, {
            canCopy: () => focused().nonEmpty(),
            canCut: () => false,
            canPaste: (entry: ClipboardEntry) => entry.type === type && focused().nonEmpty(),
            copy: () => focused().map(copy),
            cut: () => Option.None,
            paste: (entry: ClipboardEntry) => focused().ifSome(index => paste(index, entry))
        }))
    }
}
