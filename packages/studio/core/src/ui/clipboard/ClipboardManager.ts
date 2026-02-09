import {Client, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {Events, ReservedShortcuts} from "@opendaw/lib-dom"
import {ContextMenu} from "./ContextMenu"
import {MenuItem} from "../menu/MenuItems"
import {StudioPreferences} from "../../StudioPreferences"

const CLIPBOARD_HEADER = "OPENDAW"
const CLIPBOARD_VERSION = 2

export type ClipboardEntry<T extends string = string> = {
    readonly type: T
    readonly data: ArrayBufferLike
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

    const encode = (entry: AnyEntry): string => {
        const bytes = new Uint8Array(entry.data)
        let binary = ""
        for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i])}
        return `${CLIPBOARD_HEADER}:${CLIPBOARD_VERSION}:${entry.type}:${btoa(binary)}`
    }

    const decode = (text: string): Option<AnyEntry> => {
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
        const writeEntry = (entry: E): void => {
            fallbackEntry = Option.wrap(entry)
            navigator.clipboard?.writeText(encode(entry)).catch(() => {})
        }
        const performCopy = (): boolean => {
            if (!handler.canCopy(noClient)) {return false}
            const entry = handler.copy()
            entry.ifSome(writeEntry)
            return entry.nonEmpty()
        }
        const performCut = (): boolean => {
            if (!handler.canCut(noClient)) {return false}
            const entry = handler.cut()
            entry.ifSome(writeEntry)
            return entry.nonEmpty()
        }
        const performPaste = async () => {
            try {
                const rawText = await navigator.clipboard.readText()
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
            Events.subscribe(element, "copy", (event: ClipboardEvent) => {
                if (!handler.canCopy(noClient)) {return}
                handler.copy().ifSome(entry => {
                    event.preventDefault()
                    event.stopPropagation()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                })
            }),
            Events.subscribe(element, "cut", (event: ClipboardEvent) => {
                if (!handler.canCut(noClient)) {return}
                handler.cut().ifSome(entry => {
                    event.preventDefault()
                    event.stopPropagation()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                })
            }),
            Events.subscribe(document, "paste", (event: ClipboardEvent) => {
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {return}
                const text = event.clipboardData?.getData("text/plain") ?? ""
                const entry = decode(text)
                if (entry.nonEmpty()) {
                    if (!handler.canPaste(entry.unwrap(), noClient)) {return}
                    event.preventDefault()
                    handler.paste(entry.unwrap())
                } else {
                    fallbackEntry.ifSome(entry => {
                        if (!handler.canPaste(entry, noClient)) {return}
                        event.preventDefault()
                        handler.paste(entry)
                    })
                }
            }),
            Events.subscribe(document, "keydown", (event: KeyboardEvent) => {
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {return}
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
                const text = await Option.async(navigator.clipboard.readText())
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