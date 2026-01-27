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
        const writeEntry = (entry: E): void => {
            console.debug("[Clipboard] writeEntry: type:", entry.type, "dataLength:", entry.data.byteLength)
            fallbackEntry = Option.wrap(entry)
            navigator.clipboard?.writeText(encode(entry))
                .then(() => console.debug("[Clipboard] writeEntry: clipboard.writeText succeeded"))
                .catch(err => console.debug("[Clipboard] writeEntry: clipboard.writeText failed:", err))
        }
        const performCopy = (): void => {
            console.debug("[Clipboard] performCopy called")
            handler.copy().ifSome(writeEntry)
        }
        const performCut = (): void => {
            console.debug("[Clipboard] performCut called")
            handler.cut().ifSome(writeEntry)
        }
        const performPaste = async () => {
            console.debug("[Clipboard] performPaste called")
            try {
                const rawText = await navigator.clipboard.readText()
                console.debug("[Clipboard] performPaste: clipboard.readText succeeded, length:", rawText?.length)
                const text = Option.wrap(rawText)
                const entry = text.flatMap(decode)
                if (entry.nonEmpty()) {
                    console.debug("[Clipboard] performPaste: decoded entry, calling handler.paste")
                    handler.paste(entry.unwrap())
                } else {
                    console.debug("[Clipboard] performPaste: decode failed, trying fallback, hasFallback:", fallbackEntry.nonEmpty())
                    fallbackEntry.ifSome(entry => handler.paste(entry))
                }
            } catch (error) {
                console.debug("[Clipboard] performPaste: clipboard.readText failed:", error, "trying fallback, hasFallback:", fallbackEntry.nonEmpty())
                fallbackEntry.ifSome(entry => handler.paste(entry))
            }
        }
        return Terminable.many(
            Events.subscribe(element, "copy", (event: ClipboardEvent) => {
                console.debug("[Clipboard] NATIVE copy event fired")
                handler.copy().ifSome(entry => {
                    console.debug("[Clipboard] NATIVE copy: got entry, type:", entry.type)
                    event.preventDefault()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                    console.debug("[Clipboard] NATIVE copy: setData completed, length:", encoded.length)
                })
            }),
            Events.subscribe(element, "cut", (event: ClipboardEvent) => {
                console.debug("[Clipboard] NATIVE cut event fired")
                handler.cut().ifSome(entry => {
                    console.debug("[Clipboard] NATIVE cut: got entry, type:", entry.type)
                    event.preventDefault()
                    const encoded = encode(entry)
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encoded)
                    console.debug("[Clipboard] NATIVE cut: setData completed, length:", encoded.length)
                })
            }),
            Events.subscribe(document, "paste", (event: ClipboardEvent) => {
                console.debug("[Clipboard] NATIVE paste event fired, activeElement:", document.activeElement?.tagName)
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {
                    console.debug("[Clipboard] NATIVE paste: REJECTED - focus not in element and not body")
                    return
                }
                const text = event.clipboardData?.getData("text/plain") ?? ""
                console.debug("[Clipboard] NATIVE paste: got text, length:", text.length, "hasHeader:", text.startsWith(CLIPBOARD_HEADER))
                const entry = decode(text)
                if (entry.nonEmpty()) {
                    console.debug("[Clipboard] NATIVE paste: decoded successfully, calling handler.paste")
                    event.preventDefault()
                    handler.paste(entry.unwrap())
                } else {
                    console.debug("[Clipboard] NATIVE paste: decode failed, trying fallback, hasFallback:", fallbackEntry.nonEmpty())
                    fallbackEntry.ifSome(entry => {
                        event.preventDefault()
                        handler.paste(entry)
                    })
                }
            }),
            Events.subscribe(document, "keydown", (event: KeyboardEvent) => {
                if (!element.contains(document.activeElement) && document.activeElement !== document.body) {
                    return
                }
                const isMod = event.metaKey || event.ctrlKey
                if (!isMod || event.shiftKey || event.altKey) {
                    return
                }
                if (event.key === "c") {
                    console.debug("[Clipboard] KEYDOWN: Cmd+C detected")
                    event.preventDefault()
                    performCopy()
                } else if (event.key === "x") {
                    console.debug("[Clipboard] KEYDOWN: Cmd+X detected")
                    event.preventDefault()
                    performCut()
                } else if (event.key === "v") {
                    console.debug("[Clipboard] KEYDOWN: Cmd+V detected")
                    event.preventDefault()
                    performPaste()
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
