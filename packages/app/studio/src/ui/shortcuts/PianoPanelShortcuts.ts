import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const PianoPanelShortcutsFactory = ShortcutValidator.validate({
    "position-increment": {
        shortcut: Shortcut.of(Key.ArrowDown),
        description: "Move playback position forwards"
    },
    "position-decrement": {
        shortcut: Shortcut.of(Key.ArrowUp),
        description: "Move playback position backwards"
    }
})

export const PianoPanelShortcuts = ShortcutDefinitions.copy(PianoPanelShortcutsFactory)