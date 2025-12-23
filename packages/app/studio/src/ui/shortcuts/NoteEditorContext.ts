import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const NoteEditorShortcutsFactory = ShortcutValidator.validate({
    "move-cursor-right": {
        keys: Shortcut.of(Key.ArrowRight),
        description: "Move playback cursor right"
    }
})

export const NoteEditorShortcuts = ShortcutDefinitions.copy(NoteEditorShortcutsFactory)