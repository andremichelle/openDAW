import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const RegionsShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Selection,
    "toggle-mute": {
        shortcut: Shortcut.of(Key.KeyM),
        description: "Toggle mute"
    }
})

export const RegionsShortcuts = ShortcutDefinitions.copy(RegionsShortcutsFactory)