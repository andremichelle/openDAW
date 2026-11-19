import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const TimeSelectionShortcutsFactory = ShortcutValidator.validate({
    "delete-time": {
        shortcut: Shortcut.of(Key.DeleteAction),
        description: "Delete the time selection and pull later material"
    },
    "insert-time": {
        shortcut: Shortcut.of(Key.KeyI, {ctrl: true}),
        description: "Insert time at the time selection and push later material"
    },
    "insert-region": {
        shortcut: Shortcut.of(Key.KeyI, {alt: true}),
        description: "Insert time at the time selection and fill it with new regions"
    }
})

export const TimeSelectionShortcuts = ShortcutDefinitions.copy(TimeSelectionShortcutsFactory)
