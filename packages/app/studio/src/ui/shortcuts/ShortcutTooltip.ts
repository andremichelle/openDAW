import {Shortcut} from "@opendaw/lib-dom"
import {ValueOrProvider} from "@opendaw/lib-std"

export namespace ShortcutTooltip {
    export const create = (label: string, shortcut: Shortcut): ValueOrProvider<string> => `${label} (${shortcut.format()})`
}