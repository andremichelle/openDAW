import {Shortcut} from "@moises-ai/lib-dom"
import {ValueOrProvider} from "@moises-ai/lib-std"

export namespace ShortcutTooltip {
    export const create = (label: string, shortcut: Shortcut): ValueOrProvider<string> =>
        `${label} (${shortcut.format().join("")})`
}