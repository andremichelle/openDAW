import {Client, JSONValue, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {Events, Key, Shortcut} from "@opendaw/lib-dom"
import {ContextMenu} from "./ContextMenu"
import {MenuItem} from "./menu-item"

const CLIPBOARD_PREFIX = "OPENDAW:1:"

const CopyShortcut = Shortcut.of(Key.KeyC, {ctrl: true})
const CutShortcut = Shortcut.of(Key.KeyX, {ctrl: true})
const PasteShortcut = Shortcut.of(Key.KeyV, {ctrl: true})

export interface ClipboardHandler<T extends JSONValue> {
    canCopy(client: Client): boolean
    canCut(client: Client): boolean
    canPaste(entry: T, client: Client): boolean
    copy(): Option<T>
    cut(): Option<T>
    paste(entry: T): void
}

export namespace ClipboardManager {
    let fallbackEntry: Option<JSONValue> = Option.None

    const encode = (entry: JSONValue): string => `${CLIPBOARD_PREFIX}${JSON.stringify(entry)}`
    const decode = <T extends JSONValue>(text: string): Option<T> => text.startsWith(CLIPBOARD_PREFIX)
        ? Option.tryCatch(() => JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as T)
        : Option.None

    export const install = <T extends JSONValue>(element: HTMLElement, handler: ClipboardHandler<T>): Subscription => {
        const writeEntry = (entry: T): void => {
            fallbackEntry = Option.wrap(entry)
            navigator.clipboard?.writeText(encode(entry)).catch(() => {})
        }
        const performCopy = (): void => handler.copy().ifSome(writeEntry)
        const performCut = (): void => handler.cut().ifSome(writeEntry)
        const performPaste = async (): Promise<void> => {
            const text = await Option.async(navigator.clipboard.readText())
            const entry = text.flatMap(decode<T>)
            if (entry.nonEmpty()) {
                handler.paste(entry.unwrap())
            } else {
                (fallbackEntry as Option<T>).ifSome(entry => handler.paste(entry))
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
                const entry = decode<T>(text)
                if (entry.nonEmpty()) {
                    event.preventDefault()
                    handler.paste(entry.unwrap())
                } else {
                    (fallbackEntry as Option<T>).ifSome(entry => {
                        event.preventDefault()
                        handler.paste(entry)
                    })
                }
            }),
            ContextMenu.subscribe(element, async collector => {
                const {client} = collector
                const text = await Option.async(navigator.clipboard.readText())
                const entry = text.flatMap(decode<T>)
                const canPaste = entry.map(entry => handler.canPaste(entry, client))
                    .unwrapOrElse(() => (fallbackEntry as Option<T>)
                        .map(entry => handler.canPaste(entry, client)).unwrapOrElse(false))
                collector.addItems(
                    MenuItem.default({
                        label: "Cut",
                        shortcut: CutShortcut.format(),
                        selectable: handler.canCut(client)
                    }).setTriggerProcedure(performCut),
                    MenuItem.default({
                        label: "Copy",
                        shortcut: CopyShortcut.format(),
                        selectable: handler.canCopy(client)
                    }).setTriggerProcedure(performCopy),
                    MenuItem.default({
                        label: "Paste",
                        shortcut: PasteShortcut.format(),
                        selectable: canPaste
                    }).setTriggerProcedure(performPaste)
                )
            }))
    }
}