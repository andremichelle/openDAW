import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const RegionsShortcutsFactory = ShortcutValidator.validate({
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
    },
    "delete-time": {
        shortcut: Shortcut.of(Key.DeleteAction, {ctrl: true, shift: true}),
        description: "Delete the time selection and pull later material"
    },
    "insert-time": {
        shortcut: Shortcut.of(Key.KeyI, {ctrl: true}),
        description: "Insert time at the time selection and push later material"
    }
})

export const RegionsShortcuts = ShortcutDefinitions.copy(RegionsShortcutsFactory)