import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const RegionsShortcutsFactory = ShortcutValidator.validate({
    "reverse-audio": {
        shortcut: Shortcut.of(Key.KeyV, {shift: true}),
        description: "Reverse selected audio clips or regions"
    },
    "duplicate-regions": {
        shortcut: Shortcut.of(Key.KeyD, {ctrl: true}),
        description: "Duplicate selected regions"
    },
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