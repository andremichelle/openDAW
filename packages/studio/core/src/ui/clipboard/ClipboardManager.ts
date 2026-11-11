import {Client, isDefined, Option, RuntimeNotifier, Subscription, Terminable} from "@opendaw/lib-std"
import {Clipboard, Events, ReservedShortcuts} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu} from "./ContextMenu"
import {MenuItem} from "../menu/MenuItems"
import {StudioPreferences} from "../../StudioPreferences"

const CLIPBOARD_HEADER = "OPENDAW"
const CLIPBOARD_VERSION = 2

export type ClipboardEntry<T extends string = string> = {
    readonly type: T
    readonly data: ArrayBufferLike
    readonly count?: number
}

export interface ClipboardHandler<E extends ClipboardEntry> {
    canCopy(client: Client): boolean
    canCut(client: Client): boolean
    canPaste(entry: ClipboardEntry, client: Client): boolean
    copy(): Option<E>
    cut(): Option<E>
    paste(entry: ClipboardEntry): void
}

export namespace ClipboardManager {
    type AnyEntry = ClipboardEntry

    let fallbackEntry: Option<AnyEntry> = Option.None
    const handlers = new WeakMap<HTMLElement, ClipboardHandler<AnyEntry>>()

    export const encode = (entry: AnyEntry): string => {
        const bytes = new Uint8Array(entry.data)
        let binary = ""
        for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i])}
        return `${CLIPBOARD_HEADER}:${CLIPBOARD_VERSION}:${entry.type}:${btoa(binary)}`
    }

    const labelForType = (type: string): { one: string, many: string } => {
        switch (type) {
            case "devices": return {one: "Device", many: "Devices"}
            case "modulators": return {one: "Modulator", many: "Modulators"}
            case "regions": return {one: "Region", many: "Regions"}
            case "notes": return {one: "Note", many: "Notes"}
            case "chords": return {one: "Chord", many: "Chords"}
            case "values": return {one: "Automation point", many: "Automation points"}
            case "audio-units": return {one: "AudioUnit", many: "AudioUnits"}
            default: return {one: "Selection", many: "Selection"}
        }
    }

    const notify = (entry: AnyEntry, verb: string, icon: IconSymbol): void => {
        const {one, many} = labelForType(entry.type)
        const label = !isDefined(entry.count)
            ? `${one}(s)`
            : entry.count === 1 ? one : `${entry.count} ${many}`
        RuntimeNotifier.notify({message: `${label} ${verb} to clipboard`, icon: IconSymbol.toName(icon)})
    }

    export const peek = (): Option<AnyEntry> => fallbackEntry

    export const write = (entry: AnyEntry, cut: boolean = false): void => {
        fallbackEntry = Option.wrap(entry)
        Clipboard.writeText(encode(entry))
        if (cut) {notify(entry, "cut", IconSymbol.Scissors)} else {notify(entry, "copied", IconSymbol.Copy)}
    }

    export const decode = (text: string): Option<AnyEntry> => {
        const parts = text.split(":")
        if (parts.length < 4 || parts[0] !== CLIPBOARD_HEADER) {return Option.None}
        const version = parseInt(parts[1], 10)
        if (version !== CLIPBOARD_VERSION) {return Option.None}
        return Option.tryCatch(() => {
            const type = parts[2]
            const base64 = parts.slice(3).join(":")
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i)}
            return {type, data: bytes.buffer} as AnyEntry
        })
    }

    export const install = <E extends AnyEntry>(element: HTMLElement, handler: ClipboardHandler<E>): Subscription => {
        const noClient: Client = {clientX: 0, clientY: 0}
        handlers.set(element, handler)
        // Document listeners run in installation order, not DOM nesting order. Copy/cut belong to
        // the closest focused editor; paste may use an ancestor that accepts a different entry type.
        const ownsFocus = (entry?: AnyEntry): boolean => {
            const active = element.ownerDocument.activeElement
            if (active === element.ownerDocument.body) {return true}
            for (let node = active; node !== null; node = node.parentElement) {
                const candidate = handlers.get(node as HTMLElement)
                if (candidate !== undefined && (!isDefined(entry) || candidate.canPaste(entry, noClient))) {
                    return node === element
                }
            }
            return false
        }
        const writeEntry = (entry: E): void => {
            fallbackEntry = Option.wrap(entry)
            Clipboard.writeText(encode(entry))
        }
        const performCopy = (): boolean => {
            if (!handler.canCopy(noClient)) {return false}
            const entry = handler.copy()
            entry.ifSome(entry => {writeEntry(entry); notify(entry, "copied", IconSymbol.Copy)})
            return entry.nonEmpty()
        }
        const performCut = (): boolean => {
            if (!handler.canCut(noClient)) {return false}
            const entry = handler.cut()
            entry.ifSome(entry => {writeEntry(entry); notify(entry, "cut", IconSymbol.Scissors)})
            return entry.nonEmpty()
        }
        const performPaste = async () => {
            try {
                const rawText = await Clipboard.readText()
                const text = Option.wrap(rawText)
                const entry = text.flatMap(decode)
                if (entry.nonEmpty()) {
                    if (!handler.canPaste(entry.unwrap(), noClient)) {return}
                    handler.paste(entry.unwrap())
                } else {
                    fallbackEntry.ifSome(entry => {
                        if (!handler.canPaste(entry, noClient)) {return}
                        handler.paste(entry)
                    })
                }
            } catch (_error) {
                fallbackEntry.ifSome(entry => {
                    if (!handler.canPaste(entry, noClient)) {return}
                    handler.paste(entry)
                })
            }
        }
        return Terminable.many(
            {terminate: () => {if (handlers.get(element) === handler) {handlers.delete(element)}}},
            Events.subscribe(element, "copy", (event: ClipboardEvent) => {
                if (Events.isTextInput(document.activeElement)) {return}
                if (!ownsFocus() || !handler.canCopy(noClient)) {return}
                handler.copy().ifSome(entry => {
                    event.preventDefault()
                    event.stopPropagation()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                    notify(entry, "copied", IconSymbol.Copy)
                })
            }),
            Events.subscribe(element, "cut", (event: ClipboardEvent) => {
                if (Events.isTextInput(document.activeElement)) {return}
                if (!ownsFocus() || !handler.canCut(noClient)) {return}
                handler.cut().ifSome(entry => {
                    event.preventDefault()
                    event.stopPropagation()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                    notify(entry, "cut", IconSymbol.Scissors)
                })
            }),
            Events.subscribe(document, "paste", (event: ClipboardEvent) => {
                if (Events.isTextInput(document.activeElement)) {return}
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {return}
                const text = event.clipboardData?.getData("text/plain") ?? ""
                const entry = decode(text)
                if (entry.nonEmpty()) {
                    if (!ownsFocus(entry.unwrap()) || !handler.canPaste(entry.unwrap(), noClient)) {return}
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    handler.paste(entry.unwrap())
                } else {
                    fallbackEntry.ifSome(entry => {
                        if (!ownsFocus(entry) || !handler.canPaste(entry, noClient)) {return}
                        event.preventDefault()
                        event.stopImmediatePropagation()
                        handler.paste(entry)
                    })
                }
            }),
            Events.subscribe(document, "keydown", (event: KeyboardEvent) => {
                if (Events.isTextInput(document.activeElement)) {return}
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {return}
                if (!ownsFocus()) {return}
                const isMod = event.metaKey || event.ctrlKey
                if (!isMod || event.shiftKey || event.altKey) {return}
                if (event.key === "c") {
                    if (performCopy()) {
                        event.preventDefault()
                        event.stopImmediatePropagation()
                    }
                } else if (event.key === "x") {
                    if (performCut()) {
                        event.preventDefault()
                        event.stopImmediatePropagation()
                    }
                }
            }),
            ContextMenu.subscribe(element, async collector => {
                if (!StudioPreferences.settings.editing["show-clipboard-menu"]) {return}
                const {client} = collector
                const text = await Option.async(Clipboard.readText())
                const entry = text.flatMap(decode)
                const canPaste = entry.map(entry => handler.canPaste(entry, client))
                    .unwrapOrElse(() => fallbackEntry
                        .map(entry => handler.canPaste(entry, client)).unwrapOrElse(false))
                collector.addItems(
                    MenuItem.default({
                        label: "Cut",
                        shortcut: ReservedShortcuts.Cut.format(),
                        selectable: handler.canCut(client)
                    }).setTriggerProcedure(performCut),
                    MenuItem.default({
                        label: "Copy",
                        shortcut: ReservedShortcuts.Copy.format(),
                        selectable: handler.canCopy(client)
                    }).setTriggerProcedure(performCopy),
                    MenuItem.default({
                        label: "Paste",
                        shortcut: ReservedShortcuts.Paste.format(),
                        selectable: canPaste
                    }).setTriggerProcedure(performPaste)
                )
            }))
    }
}