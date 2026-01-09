import {Client, JSONValue, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {Events, ReservedShortcuts} from "@opendaw/lib-dom"
import {ContextMenu} from "./ContextMenu"
import {MenuItem} from "./MenuItems"

const CLIPBOARD_PREFIX = "OPENDAW:1:"

export type ClipboardEntry<T extends string = string, D extends JSONValue = JSONValue> = {
    readonly type: T
    readonly data: D
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

    const encode = (entry: AnyEntry): string => `${CLIPBOARD_PREFIX}${JSON.stringify(entry)}`
    const decode = (text: string): Option<AnyEntry> => text.startsWith(CLIPBOARD_PREFIX)
        ? Option.tryCatch(() => JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as AnyEntry)
        : Option.None

    export const install = <E extends AnyEntry>(element: HTMLElement, handler: ClipboardHandler<E>): Subscription => {
        const writeEntry = (entry: E): void => {
            fallbackEntry = Option.wrap(entry)
            navigator.clipboard?.writeText(encode(entry)).catch(() => {})
        }
        const performCopy = (): void => handler.copy().ifSome(writeEntry)
        const performCut = (): void => handler.cut().ifSome(writeEntry)
        const performPaste = async (): Promise<void> => {
            const text = await Option.async(navigator.clipboard.readText())
            const entry = text.flatMap(decode)
            if (entry.nonEmpty()) {
                handler.paste(entry.unwrap())
            } else {
                fallbackEntry.ifSome(entry => handler.paste(entry))
            }
        }
        return Terminable.many(
            Events.subscribe(element, "copy", (event: ClipboardEvent) => {
                handler.copy().ifSome(entry => {
                    event.preventDefault()
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encode(entry))
                })
            }),
            Events.subscribe(element, "cut", (event: ClipboardEvent) => {
                handler.cut().ifSome(entry => {
                    event.preventDefault()
                    fallbackEntry = Option.wrap(entry)
                    event.clipboardData?.setData("text/plain", encode(entry))
                })
            }),
            Events.subscribe(element, "paste", (event: ClipboardEvent) => {
                const text = event.clipboardData?.getData("text/plain") ?? ""
                const entry = decode(text)
                if (entry.nonEmpty()) {
                    event.preventDefault()
                    handler.paste(entry.unwrap())
                } else {
                    fallbackEntry.ifSome(entry => {
                        event.preventDefault()
                        handler.paste(entry)
                    })
                }
            }),
            ContextMenu.subscribe(element, async collector => {
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