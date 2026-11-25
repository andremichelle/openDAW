import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const EuclidShortcutsFactory = ShortcutValidator.validate({
    "delete-lane": {
        shortcut: Shortcut.of(Key.DeleteAction),
        description: "Delete the focused Euclid lane"
    }
})

export const EuclidShortcuts = ShortcutDefinitions.copy(EuclidShortcutsFactory)
