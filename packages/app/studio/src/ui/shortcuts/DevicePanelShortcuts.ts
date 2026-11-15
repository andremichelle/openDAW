import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const DevicePanelShortcutsFactory = ShortcutValidator.validate({
    "delete-audio-unit": {
        shortcut: Shortcut.of(Key.DeleteAction),
        description: "Delete the focused audio unit (instrument + its effect chain), or the focused pad or layer"
    },
    "play-pad": {
        shortcut: Shortcut.of(Key.Comma),
        description: "Play the edited Playfield pad while held"
    }
})

export const DevicePanelShortcuts = ShortcutDefinitions.copy(DevicePanelShortcutsFactory)