import {int, isDefined, isRecord, Maybe, Lifecycle, Option, Optional, RuntimeNotifier, tryCatch, UUID} from "@opendaw/lib-std"
import {Clipboard} from "@opendaw/lib-dom"
import {Box, PointerField, PointerHub} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ClipboardEntry, ClipboardManager} from "@opendaw/studio-core"

/** A device pattern on the studio clipboard as JSON, its groove by uuid so it only returns into the same project. */
export namespace PatternClipboard {
    export type Format<T> = { readonly type: string, readonly valid: (value: unknown) => value is T }

    export const encode = <T>({type}: Format<T>, value: T): ClipboardEntry =>
        ({type, data: new TextEncoder().encode(JSON.stringify(value)).buffer, count: 1})

    export const decode = <T>({type, valid}: Format<T>, entry: ClipboardEntry): Option<T> => {
        if (entry.type !== type) {return Option.None}
        const {status, value} = tryCatch((): unknown => JSON.parse(new TextDecoder().decode(entry.data)))
        return status === "success" && valid(value) ? Option.wrap(value) : Option.None
    }

    export const pastable = <T>(format: Format<T>): boolean =>
        ClipboardManager.peek().mapOr(entry => decode(format, entry).nonEmpty(), false)

    /** The menu's Paste: the system clipboard first, then the studio's own, like every other paste menu. */
    export const pasteFromMenu = async <T>(format: Format<T>, target: Box, apply: (value: T) => void): Promise<void> => {
        const system = (await Option.async(Clipboard.readText())).flatMap(ClipboardManager.decode)
        if (!target.isAttached()) {return}
        const entry = system.nonEmpty() ? system : ClipboardManager.peek()
        entry.flatMap(each => decode(format, each)).match({
            none: () => RuntimeNotifier.notify({message: "The clipboard holds no pattern", icon: "Warning"}),
            some: apply
        })
    }

    export const isGroove = (value: unknown): value is Maybe<UUID.String> =>
        !isDefined(value) || (typeof value === "string" && UUID.validateString(value))

    /** Whether `value` has the shape of `template`: the same keys and array lengths, the same type at every leaf. */
    export const sameShape = (template: unknown, value: unknown): boolean => {
        if (!isDefined(template)) {return !isDefined(value)}
        if (typeof template === "number") {return typeof value === "number" && Number.isFinite(value)}
        if (Array.isArray(template)) {
            return Array.isArray(value) && value.length === template.length
                && template.every((entry, index) => sameShape(entry, value[index]))
        }
        if (isRecord(template)) {
            return isRecord(value) && !Array.isArray(value)
                && Object.keys(template).every(key => sameShape(template[key], value[key]))
        }
        return typeof template === typeof value
    }

    export const grooveOf = (pointer: PointerField<Pointers.Groove>): Optional<UUID.String> =>
        pointer.targetVertex.mapOr(({box}) => UUID.toString(box.address.uuid), undefined)

    export const referGroove = (pointer: PointerField<Pointers.Groove>, groove: Maybe<UUID.String>): void =>
        Option.wrap(groove).flatMap(uuid => pointer.graph.findBox(UUID.parse(uuid)))
            .flatMap(target => PointerHub.validate(pointer, target).isEmpty() ? Option.wrap(target) : Option.None)
            .match({none: () => pointer.defer(), some: target => pointer.refer(target)})

    /** Cmd+C and Cmd+V on the focused tile of `tiles` copy and paste its pattern. */
    export const install = <T>(lifecycle: Lifecycle, element: HTMLElement, format: Format<T>, tiles: ReadonlyArray<HTMLElement>,
                               copy: (index: int) => ClipboardEntry, paste: (index: int, entry: ClipboardEntry) => void): void => {
        const focused = (): Option<int> => {
            const index = tiles.findIndex(tile => tile === document.activeElement)
            return index >= 0 ? Option.wrap(index) : Option.None
        }
        lifecycle.own(ClipboardManager.install(element, {
            canCopy: () => focused().nonEmpty(),
            canCut: () => false,
            canPaste: (entry: ClipboardEntry) => focused().nonEmpty() && decode(format, entry).nonEmpty(),
            copy: () => focused().map(copy),
            cut: () => Option.None,
            paste: (entry: ClipboardEntry) => focused().ifSome(index => paste(index, entry))
        }))
    }
}
