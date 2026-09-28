import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const RegionsShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Selection,
    ...CommonShortcuts.Snapping,
    "toggle-mute": {
        shortcut: Shortcut.of(Key.KeyM),
        description: "Toggle mute"
    },
    "loop-selection": {
        shortcut: Shortcut.of(Key.KeyL, {ctrl: true, shift: true}),
        description: "Loop selected regions"
    }
})

export const RegionsShortcuts = ShortcutDefinitions.copy(RegionsShortcutsFactory)